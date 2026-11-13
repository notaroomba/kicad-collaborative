/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

#include <collab/collab_fonts.h>

#include <collab/collab_rest.h>
#include <collab/collab_session.h>
#include <font/fontconfig.h>
#include <font/kicad_font_name.h>
#include <kicad_curl/kicad_curl_easy.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <thread>

#include <wx/app.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/intl.h>
#include <wx/log.h>
#include <wx/thread.h>
#include <wx/utils.h>

static const wxChar* const traceFonts = wxT( "COLLAB_FONTS" );

static const COLLAB_FONTS::GOOGLE_FAMILY s_googleFamilies[] = {
#include "../font/google_fonts_list.inc"
};


const wxArrayString& COLLAB_FONTS::GoogleFamilies()
{
    static wxArrayString s_names;
    static std::once_flag s_once;

    std::call_once( s_once,
            []()
            {
                for( const GOOGLE_FAMILY& family : s_googleFamilies )
                    s_names.Add( wxString::FromUTF8( family.family ) );
            } );

    return s_names;
}


const COLLAB_FONTS::GOOGLE_FAMILY* COLLAB_FONTS::FindGoogleFamily( const wxString& aFamily )
{
    static std::map<wxString, const GOOGLE_FAMILY*> s_byName;
    static std::once_flag s_once;

    std::call_once( s_once,
            []()
            {
                for( const GOOGLE_FAMILY& family : s_googleFamilies )
                    s_byName[wxString::FromUTF8( family.family ).Lower()] = &family;
            } );

    wxString key = aFamily.Lower();
    key.Trim( true ).Trim( false );

    auto it = s_byName.find( key );
    return it == s_byName.end() ? nullptr : it->second;
}


void COLLAB_FONTS::FacesInText( const std::string& aText, std::set<wxString>& aFaces )
{
    static const std::string token = "(face \"";

    for( size_t at = aText.find( token ); at != std::string::npos; at = aText.find( token, at ) )
    {
        at += token.size();

        std::string name;
        bool        closed = false;

        for( ; at < aText.size(); ++at )
        {
            char c = aText[at];

            if( c == '\\' && at + 1 < aText.size() )
            {
                name += aText[++at];
            }
            else if( c == '"' )
            {
                closed = true;
                break;
            }
            else
            {
                name += c;
            }
        }

        if( closed && !name.empty() )
            aFaces.insert( wxString::FromUTF8( name ) );
    }
}


static void collectFaces( const nlohmann::json& aNode, std::set<wxString>& aFaces )
{
    if( aNode.is_string() )
    {
        COLLAB_FONTS::FacesInText( aNode.get_ref<const std::string&>(), aFaces );
    }
    else if( aNode.is_structured() )
    {
        for( const nlohmann::json& child : aNode )
            collectFaces( child, aFaces );
    }
}


std::set<wxString> COLLAB_FONTS::FacesIn( const nlohmann::json& aPayload )
{
    std::set<wxString> faces;
    collectFaces( aPayload, faces );
    return faces;
}


wxString COLLAB_FONTS::FileNameFor( const wxString& aFamily, bool aBold, bool aItalic, bool aOpenType )
{
    wxString name;

    // A family name is not a file name: keep what every file system takes.
    for( wxUniChar c : aFamily )
    {
        if( wxIsalnum( c ) || c == ' ' || c == '-' || c == '_' || c > 127 )
            name += c;
        else
            name += '_';
    }

    name.Trim( true ).Trim( false );

    if( name.IsEmpty() )
        name = wxS( "font" );

    name += aBold ? ( aItalic ? wxS( "-BoldItalic" ) : wxS( "-Bold" ) )
                  : ( aItalic ? wxS( "-Italic" ) : wxS( "-Regular" ) );

    return name + ( aOpenType ? wxS( ".otf" ) : wxS( ".ttf" ) );
}


// ---- the work ----------------------------------------------------------------------------------

namespace
{

/// The online project a font is fetched from or uploaded to; empty strings when there is none.
struct ONLINE_PROJECT
{
    wxString server;
    wxString token;
    wxString id;

    bool Valid() const { return !server.IsEmpty() && !token.IsEmpty() && !id.IsEmpty(); }
};


enum class FETCH
{
    RUNNING,
    DONE,
    FAILED
};


struct TASK
{
    std::chrono::steady_clock::time_point due;
    std::function<void()>                 run;
};


/// Everything the background thread touches.  Never destroyed: a download may still be under
/// way when the statics of this library are torn down.
struct STATE
{
    std::mutex              mutex;
    std::condition_variable wake;
    std::deque<TASK>        tasks;
    std::thread             worker;
    bool                    stop = false;
    bool                    installed = false;

    /// family (lower case) -> how fetching it went, and when it last failed
    std::map<wxString, std::pair<FETCH, std::chrono::steady_clock::time_point>> fetches;

    /// "project|family" of the faces NoteFaces() already dealt with
    std::set<wxString> noted;

    /// fonts whose upload was refused, already reported to the user
    std::set<wxString> refused;
};


STATE& state()
{
    static STATE* s_state = new STATE();
    return *s_state;
}


void enqueue( std::function<void()> aTask, int aDelaySeconds = 0 )
{
    STATE& s = state();
    std::unique_lock<std::mutex> lock( s.mutex );

    if( s.stop )
        return;

    s.tasks.push_back( { std::chrono::steady_clock::now() + std::chrono::seconds( aDelaySeconds ),
                         std::move( aTask ) } );

    if( !s.worker.joinable() )
    {
        s.worker = std::thread(
                []()
                {
                    STATE& st = state();

                    for( ;; )
                    {
                        std::function<void()> task;

                        {
                            std::unique_lock<std::mutex> workLock( st.mutex );

                            for( ;; )
                            {
                                if( st.stop )
                                    return;

                                auto now = std::chrono::steady_clock::now();
                                auto next = std::min_element( st.tasks.begin(), st.tasks.end(),
                                        []( const TASK& a, const TASK& b ) { return a.due < b.due; } );

                                if( next == st.tasks.end() )
                                {
                                    st.wake.wait( workLock );
                                }
                                else if( next->due > now )
                                {
                                    st.wake.wait_until( workLock, next->due );
                                }
                                else
                                {
                                    task = std::move( next->run );
                                    st.tasks.erase( next );
                                    break;
                                }
                            }
                        }

                        task();
                    }
                } );
    }

    lock.unlock();
    s.wake.notify_all();
}


ONLINE_PROJECT currentProject()
{
    ONLINE_PROJECT project;

    if( COLLAB_SESSION::Exists() )
    {
        COLLAB_SESSION& session = COLLAB_SESSION::Get();

        if( !session.ProjectId().IsEmpty() && !session.Token().IsEmpty() )
        {
            project.server = COLLAB_SESSION::ServerUrl();
            project.token = session.Token();
            project.id = session.ProjectId();
        }
    }

    return project;
}


bool looksLikeFont( const std::string& aData )
{
    if( aData.size() < 512 )
        return false;

    static const char trueType[] = { 0, 1, 0, 0 };

    return aData.compare( 0, 4, trueType, 4 ) == 0 || aData.compare( 0, 4, "OTTO" ) == 0
           || aData.compare( 0, 4, "true" ) == 0;
}


/// One style of a Google family, straight from Google Fonts: its stylesheet names the file.
std::string downloadFromGoogle( const COLLAB_FONTS::GOOGLE_FAMILY& aFamily, bool aBold, bool aItalic )
{
    int weight = aBold ? aFamily.bold : aFamily.regular;

    KICAD_CURL_EASY css;

    std::string family = css.Escape( aFamily.family );
    std::string url = "https://fonts.googleapis.com/css2?family=" + family + ":ital,wght@"
                      + ( aItalic ? "1," : "0," ) + std::to_string( weight );

    css.SetURL( url );
    css.SetUserAgent( "junction-fonts/1" );     // a plain agent is answered with TrueType files
    css.SetFollowRedirects( true );
    css.SetConnectTimeout( 8 );
    css.SetTimeout( 20 );

    if( css.Perform() != 0 || css.GetResponseStatusCode() != 200 )
        return std::string();

    const std::string& sheet = css.GetBuffer();
    size_t             start = sheet.find( "url(" );
    size_t             end = start == std::string::npos ? start : sheet.find( ')', start );

    if( end == std::string::npos )
        return std::string();

    std::string file = sheet.substr( start + 4, end - start - 4 );

    // The stylesheet is only trusted to point at Google's own file host.
    if( file.rfind( "https://fonts.gstatic.com/", 0 ) != 0 )
        return std::string();

    KICAD_CURL_EASY font;

    font.SetURL( file );
    font.SetUserAgent( "junction-fonts/1" );
    font.SetFollowRedirects( true );
    font.SetConnectTimeout( 8 );
    font.SetTimeout( 30 );

    if( font.Perform() != 0 || font.GetResponseStatusCode() != 200 )
        return std::string();

    return font.GetBuffer();
}


/// Download the styles of a family that can be had and put them where the program finds them.
/// @return the files written.
std::vector<wxString> fetchFamily( const wxString& aFamily, const ONLINE_PROJECT& aProject )
{
    std::vector<wxString>              files;
    const COLLAB_FONTS::GOOGLE_FAMILY* google = COLLAB_FONTS::FindGoogleFamily( aFamily );
    wxString                           dir = fontconfig::FONTCONFIG::DownloadedFontsDir();

    for( int style = 0; style < 4; ++style )
    {
        bool        bold = style & 1;
        bool        italic = style & 2;
        std::string data;

        // The project first: it has the fonts collaborators uploaded, and answers for Google
        // Fonts too.
        if( aProject.Valid() )
        {
            if( auto got = COLLAB_REST::DownloadProjectFont( aProject.server, aProject.token, aProject.id,
                                                            aFamily, bold, italic ) )
            {
                data = std::move( *got );
            }
        }

        if( !looksLikeFont( data ) && google )
        {
            bool has = ( !bold || google->bold != 0 )
                       && ( !italic || ( google->italics & ( bold ? 2 : 1 ) ) != 0 );

            data = has ? downloadFromGoogle( *google, bold, italic ) : std::string();
        }

        if( !looksLikeFont( data ) )
        {
            // Without a regular there is no family to speak of.
            if( style == 0 )
                break;

            continue;
        }

        if( !wxFileName::DirExists( dir ) && !wxFileName::Mkdir( dir, wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
            break;

        wxFileName path( dir, COLLAB_FONTS::FileNameFor( aFamily, bold, italic, data.compare( 0, 4, "OTTO" ) == 0 ) );
        wxFFile    out( path.GetFullPath(), wxS( "wb" ) );

        if( out.IsOpened() && out.Write( data.data(), data.size() ) == data.size() && out.Close() )
            files.push_back( path.GetFullPath() );
    }

    wxLogTrace( traceFonts, wxS( "fetch '%s': %zu files" ), aFamily, files.size() );
    return files;
}


void setFetch( const wxString& aFamily, FETCH aResult )
{
    STATE& s = state();
    std::lock_guard<std::mutex> lock( s.mutex );
    s.fetches[aFamily.Lower()] = { aResult, std::chrono::steady_clock::now() };
}


/// Fetch in the background.  A font an online project does not have yet is asked for again a
/// few times: the collaborator who set the text may still be uploading it.
void fetchLater( const wxString& aFamily, const ONLINE_PROJECT& aProject, int aAttempt, int aDelaySeconds )
{
    enqueue(
            [aFamily, aProject, aAttempt]()
            {
                std::vector<wxString> files = fetchFamily( aFamily, aProject );

                if( !files.empty() )
                {
                    setFetch( aFamily, FETCH::DONE );
                    Fontconfig()->AddFontFiles( files );
                    return;
                }

                static const int retryAfter[] = { 5, 20, 60 };

                if( aProject.Valid() && aAttempt < 3 )
                    fetchLater( aFamily, aProject, aAttempt + 1, retryAfter[aAttempt] );
                else
                    setFetch( aFamily, FETCH::FAILED );
            },
            aDelaySeconds );
}


/// FONTCONFIG's missing-font handler; whichever thread looked the font up.
void onMissingFont( const wxString& aFamily )
{
    if( aFamily.IsEmpty() || aFamily.StartsWith( KICAD_FONT_NAME ) )
        return;

    // The command line tools and the tests draw with the fonts they have: nothing of theirs
    // waits for a download, and a test must not depend on the network.
    if( !wxTheApp || !wxTheApp->IsGUI() )
        return;

    ONLINE_PROJECT project = currentProject();

    // Nowhere to get it from: the substitute stands, as it always did.
    if( !project.Valid() && !COLLAB_FONTS::FindGoogleFamily( aFamily ) )
        return;

    {
        STATE& s = state();
        std::lock_guard<std::mutex> lock( s.mutex );

        auto it = s.fetches.find( aFamily.Lower() );

        if( it != s.fetches.end() )
        {
            bool stale = it->second.first == FETCH::FAILED
                         && std::chrono::steady_clock::now() - it->second.second > std::chrono::minutes( 5 );

            if( !stale )
                return;
        }

        s.fetches[aFamily.Lower()] = { FETCH::RUNNING, std::chrono::steady_clock::now() };
    }

    fetchLater( aFamily, project, 0, 0 );
}


/// Keep a font of this computer with the project (background thread).
void uploadFamily( const wxString& aFamily, const std::vector<fontconfig::FONTCONFIG::FAMILY_FILE>& aFiles,
                   const ONLINE_PROJECT& aProject )
{
    // Already there?  (Somebody else who has the font, or an earlier session.)
    if( auto list = COLLAB_REST::ListProjectFonts( aProject.server, aProject.token, aProject.id ) )
    {
        if( list->contains( "fonts" ) && ( *list )["fonts"].is_array() )
        {
            for( const nlohmann::json& font : ( *list )["fonts"] )
            {
                if( wxString::FromUTF8( font.value( "family", "" ) ).CmpNoCase( aFamily ) == 0 )
                    return;
            }
        }
    }

    for( const fontconfig::FONTCONFIG::FAMILY_FILE& file : aFiles )
    {
        wxFFile     in( file.file, wxS( "rb" ) );
        std::string bytes;

        if( !in.IsOpened() )
            continue;

        wxFileOffset length = in.Length();

        // The server takes 40 MB at most.
        if( length <= 0 || length > 40 * 1024 * 1024 )
            continue;

        bytes.resize( static_cast<size_t>( length ) );

        if( in.Read( bytes.data(), bytes.size() ) != bytes.size() )
            continue;

        COLLAB_REST::ERROR_INFO error;

        bool stored = COLLAB_REST::UploadProjectFont( aProject.server, aProject.token, aProject.id, aFamily,
                                                      file.bold, file.italic, file.index,
                                                      wxFileName( file.file ).GetFullName(), bytes, &error );

        wxLogTrace( traceFonts, wxS( "upload '%s' %s: %d" ), aFamily, file.file, error.status );

        if( !stored && error.status == 403 && !error.message.IsEmpty() )
        {
            // The font's licence forbids embedding (or we may only view the project): say so
            // once; the other styles of the family will be answered the same.
            bool first = false;

            {
                STATE& s = state();
                std::lock_guard<std::mutex> lock( s.mutex );
                first = s.refused.insert( aFamily.Lower() ).second;
            }

            if( first && wxTheApp )
            {
                wxString message = error.message + wxS( "\n\n" )
                                   + _( "People who open the project without this font installed see a "
                                        "substitute font." );

                wxTheApp->CallAfter( [message]() { wxLogWarning( message ); } );
            }

            return;
        }
    }
}

} // namespace


bool COLLAB_FONTS::FetchNow( const wxString& aFamily )
{
    if( Fontconfig()->HasFamily( aFamily ) )
        return true;

    ONLINE_PROJECT project = currentProject();

    if( !project.Valid() && !FindGoogleFamily( aFamily ) )
        return false;

    std::vector<wxString> files = fetchFamily( aFamily, project );

    if( files.empty() )
        return false;

    setFetch( aFamily, FETCH::DONE );
    Fontconfig()->AddFontFiles( files );
    return true;
}


void COLLAB_FONTS::Install()
{
    {
        STATE& s = state();
        std::lock_guard<std::mutex> lock( s.mutex );

        if( s.installed )
            return;

        s.installed = true;
    }

    if( wxGetEnv( wxS( "KICAD_NO_FONT_FETCH" ), nullptr ) )
        return;

    fontconfig::FONTCONFIG::SetMissingFontHandler( onMissingFont );
}


static void noteFaces( const std::set<wxString>& aFaces )
{
    ONLINE_PROJECT project = currentProject();

    if( !project.Valid() )
        return;

    for( const wxString& face : aFaces )
    {
        if( face.StartsWith( KICAD_FONT_NAME ) )
            continue;

        {
            STATE& s = state();
            std::lock_guard<std::mutex> lock( s.mutex );

            if( !s.noted.insert( project.id + wxS( "|" ) + face.Lower() ).second )
                continue;
        }

        std::vector<fontconfig::FONTCONFIG::FAMILY_FILE> files = Fontconfig()->FamilyFiles( face );

        if( files.empty() )
        {
            // Not on this computer: the project has it, or will in a moment.
            onMissingFont( face );
            continue;
        }

        // The server fetches Google Fonts itself, and what we downloaded came from there or
        // from the project in the first place.
        wxString downloads = fontconfig::FONTCONFIG::DownloadedFontsDir();

        if( COLLAB_FONTS::FindGoogleFamily( face ) || files.front().file.StartsWith( downloads ) )
            continue;

        enqueue( [face, files, project]() { uploadFamily( face, files, project ); } );
    }
}


void COLLAB_FONTS::NoteFaces( const nlohmann::json& aPayload )
{
    if( COLLAB_SESSION::Exists() )
        noteFaces( FacesIn( aPayload ) );
}


void COLLAB_FONTS::NoteFacesInFile( const wxString& aPath )
{
    wxFFile     in;
    std::string text;

    {
        wxLogNull quiet;    // a sheet that is not on disk yet has no fonts to speak of

        if( !wxFileName::FileExists( aPath ) || !in.Open( aPath, wxS( "rb" ) ) )
            return;
    }

    wxFileOffset length = in.Length();

    if( length <= 0 )
        return;

    text.resize( static_cast<size_t>( length ) );

    if( in.Read( text.data(), text.size() ) != text.size() )
        return;

    std::set<wxString> faces;

    FacesInText( text, faces );
    noteFaces( faces );
}


void COLLAB_FONTS::Shutdown()
{
    STATE& s = state();

    {
        std::lock_guard<std::mutex> lock( s.mutex );
        s.stop = true;
        s.tasks.clear();
    }

    s.wake.notify_all();

    if( s.worker.joinable() )
        s.worker.join();
}
