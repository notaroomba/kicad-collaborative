/*
 * This program source code file is part of Junction, a KiCad fork.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#include <wakatime.h>

#include <build_version.h>
#include <eda_base_frame.h>
#include <json_common.h>
#include <kicad_curl/kicad_curl_easy.h>
#include <project.h>

#include <wx/base64.h>
#include <wx/dir.h>
#include <wx/filename.h>
#include <wx/textfile.h>
#include <wx/time.h>
#include <wx/utils.h>

#include <thread>
#include <vector>


static const char* DEFAULT_API_URL = "https://api.wakatime.com/api/v1";
static const long long CONFIG_REREAD_MS = 30 * 1000;


WAKATIME& WAKATIME::Get()
{
    static WAKATIME s_instance;
    return s_instance;
}


static wxString homeDir()
{
    wxString home;

    if( wxGetEnv( wxT( "WAKATIME_HOME" ), &home ) && !home.IsEmpty() )
        return home;

    return wxGetHomeDir();
}


wxString WAKATIME::ConfigPath()
{
    return wxFileName( homeDir(), wxT( ".wakatime.cfg" ) ).GetFullPath();
}


// ------------------------------------------------------------------ the INI file
//
// A tiny reader and writer for ~/.wakatime.cfg that leaves every line it does not change as
// it was: other plugins keep their own keys, comments and exclude patterns in the same file.

static std::vector<wxString> readLines( const wxString& aPath )
{
    std::vector<wxString> lines;
    wxTextFile            file( aPath );

    if( wxFileExists( aPath ) && file.Open() )
    {
        for( wxString l = file.GetFirstLine(); !file.Eof(); l = file.GetNextLine() )
            lines.push_back( l );

        if( file.GetLineCount() && lines.size() < file.GetLineCount() )
            lines.push_back( file.GetLastLine() );
    }

    return lines;
}


static bool sectionOf( const wxString& aLine, wxString& aSection )
{
    wxString t = aLine.Strip( wxString::both );

    if( t.StartsWith( wxT( "[" ) ) && t.EndsWith( wxT( "]" ) ) )
    {
        aSection = t.Mid( 1, t.length() - 2 ).Strip( wxString::both ).Lower();
        return true;
    }

    return false;
}


static bool keyValue( const wxString& aLine, wxString& aKey, wxString& aValue )
{
    wxString t = aLine.Strip( wxString::both );

    if( t.IsEmpty() || t.StartsWith( wxT( "#" ) ) || t.StartsWith( wxT( ";" ) ) )
        return false;

    int eq = t.Find( '=' );

    if( eq == wxNOT_FOUND )
        return false;

    aKey = t.Left( eq ).Strip( wxString::both ).Lower();
    aValue = t.Mid( eq + 1 ).Strip( wxString::both );
    return true;
}


WAKATIME::CONFIG WAKATIME::ReadConfig()
{
    CONFIG   cfg;
    wxString section, key, value;

    for( const wxString& line : readLines( ConfigPath() ) )
    {
        if( sectionOf( line, section ) || !keyValue( line, key, value ) )
            continue;

        if( section == wxT( "settings" ) )
        {
            if( key == wxT( "api_key" ) || ( key == wxT( "apikey" ) && cfg.apiKey.IsEmpty() ) )
                cfg.apiKey = value;
            else if( key == wxT( "api_url" ) )
                cfg.apiUrl = value;
        }
        else if( section == wxT( "junction" ) && key == wxT( "enabled" ) )
        {
            cfg.enabled = !( value.CmpNoCase( wxT( "false" ) ) == 0 || value == wxT( "0" ) );
        }
    }

    cfg.apiUrl.Trim();

    while( cfg.apiUrl.EndsWith( wxT( "/" ) ) )
        cfg.apiUrl.RemoveLast();

    if( cfg.apiUrl == DEFAULT_API_URL )
        cfg.apiUrl.clear();

    return cfg;
}


/// Set `aKey` in `aSection` to `aValue` (or remove it when aValue is empty), keeping the rest.
static void setKey( std::vector<wxString>& aLines, const wxString& aSection, const wxString& aKey,
                    const wxString& aValue )
{
    wxString section, key, value;
    int      sectionEnd = -1;
    bool     inSection = false;

    for( size_t i = 0; i < aLines.size(); ++i )
    {
        if( sectionOf( aLines[i], section ) )
        {
            inSection = ( section == aSection );

            if( inSection )
                sectionEnd = (int) i + 1;

            continue;
        }

        if( !inSection )
            continue;

        if( !aLines[i].Strip( wxString::both ).IsEmpty() )
            sectionEnd = (int) i + 1;

        if( keyValue( aLines[i], key, value ) && key == aKey )
        {
            if( aValue.IsEmpty() )
                aLines.erase( aLines.begin() + i );
            else
                aLines[i] = aKey + wxT( " = " ) + aValue;

            return;
        }
    }

    if( aValue.IsEmpty() )
        return;

    if( sectionEnd < 0 )
    {
        if( !aLines.empty() && !aLines.back().Strip( wxString::both ).IsEmpty() )
            aLines.push_back( wxEmptyString );

        aLines.push_back( wxT( "[" ) + aSection + wxT( "]" ) );
        sectionEnd = (int) aLines.size();
    }

    aLines.insert( aLines.begin() + sectionEnd, aKey + wxT( " = " ) + aValue );
}


bool WAKATIME::WriteConfig( const CONFIG& aConfig )
{
    wxString              path = ConfigPath();
    std::vector<wxString> lines = readLines( path );

    setKey( lines, wxT( "settings" ), wxT( "api_key" ), aConfig.apiKey.Strip( wxString::both ) );
    setKey( lines, wxT( "settings" ), wxT( "api_url" ), aConfig.apiUrl.Strip( wxString::both ) );
    // only written when it says something: absent means on
    setKey( lines, wxT( "junction" ), wxT( "enabled" ),
            aConfig.enabled ? wxString() : wxString( wxT( "false" ) ) );

    wxTextFile file( path );

    if( wxFileExists( path ) ? !file.Open() : !file.Create() )
        return false;

    file.Clear();

    for( const wxString& l : lines )
        file.AddLine( l );

    bool ok = file.Write( wxTextFileType_Unix );

#ifndef __WINDOWS__
    // the key is a secret: like wakatime-cli, keep the file to its owner
    if( ok )
        wxFileName( path ).SetPermissions( wxPOSIX_USER_READ | wxPOSIX_USER_WRITE );
#endif

    Get().reloadConfig();
    return ok;
}


wxString WAKATIME::FindCli()
{
    // where the editor plugins install it: ~/.wakatime/wakatime-cli-<os>-<arch>[.exe], with a
    // wakatime-cli link next to it on some systems
    wxString dir = wxFileName( homeDir(), wxT( ".wakatime" ) ).GetFullPath();

    if( wxDirExists( dir ) )
    {
#ifdef __WINDOWS__
        wxString exact = wxFileName( dir, wxT( "wakatime-cli.exe" ) ).GetFullPath();
#else
        wxString exact = wxFileName( dir, wxT( "wakatime-cli" ) ).GetFullPath();
#endif
        if( wxFileExists( exact ) )
            return exact;

        wxDir    d( dir );
        wxString name;

        for( bool more = d.GetFirst( &name, wxT( "wakatime-cli-*" ), wxDIR_FILES ); more;
             more = d.GetNext( &name ) )
        {
            if( name.EndsWith( wxT( ".zip" ) ) )
                continue;

            return wxFileName( dir, name ).GetFullPath();
        }
    }

    wxPathList paths;
    paths.AddEnvList( wxT( "PATH" ) );

#ifdef __WXMAC__
    // a GUI app on macOS does not get the shell's PATH
    paths.Add( wxT( "/opt/homebrew/bin" ) );
    paths.Add( wxT( "/usr/local/bin" ) );
#endif

    for( const wxChar* name : { wxT( "wakatime-cli" ), wxT( "wakatime" ) } )
    {
#ifdef __WINDOWS__
        wxString found = paths.FindAbsoluteValidPath( wxString( name ) + wxT( ".exe" ) );
#else
        wxString found = paths.FindAbsoluteValidPath( name );
#endif
        if( !found.IsEmpty() )
            return found;
    }

    return wxEmptyString;
}


wxString WAKATIME::LanguageOf( const wxString& aFile )
{
    wxString ext = wxFileName( aFile ).GetExt().Lower();

    if( ext == wxT( "kicad_sch" ) || ext == wxT( "sch" ) )
        return wxT( "KiCad Schematic" );
    if( ext == wxT( "kicad_pcb" ) || ext == wxT( "brd" ) )
        return wxT( "KiCad PCB" );
    if( ext == wxT( "kicad_sym" ) || ext == wxT( "lib" ) )
        return wxT( "KiCad Symbol" );
    if( ext == wxT( "kicad_mod" ) || ext == wxT( "pretty" ) )
        return wxT( "KiCad Footprint" );

    return wxT( "KiCad" );
}


void WAKATIME::reloadConfig()
{
    std::lock_guard<std::mutex> lock( m_lock );
    m_config = ReadConfig();
    m_cli = FindCli();
    m_configReadAt = wxGetUTCTimeMillis().GetValue();
}


wxString WAKATIME::LastStatus() const
{
    std::lock_guard<std::mutex> lock( m_lock );
    return m_status;
}


void WAKATIME::Activity( EDA_BASE_FRAME* aFrame, bool aIsWrite )
{
    if( !aFrame )
        return;

    wxString file = aFrame->GetCurrentFileName();

    if( file.IsEmpty() )
        return;

    // cheap enough to answer on every mouse move: most calls stop here
    long long now = wxGetUTCTimeMillis().GetValue();

    {
        std::lock_guard<std::mutex> lock( m_lock );

        if( file == m_lastFile && now - m_lastAt < HEARTBEAT_EVERY_MS
            && !( aIsWrite && !m_lastWrite ) )
        {
            return;
        }
    }

    wxString project = aFrame->Prj().GetProjectName();

    if( project.IsEmpty() )
        project = wxFileName( file ).GetDirs().IsEmpty() ? wxString()
                                                         : wxFileName( file ).GetDirs().Last();

    Heartbeat( file, project, aIsWrite );
}


void WAKATIME::Heartbeat( const wxString& aFile, const wxString& aProject, bool aIsWrite )
{
    long long now = wxGetUTCTimeMillis().GetValue();

    {
        std::lock_guard<std::mutex> lock( m_lock );

        if( aFile == m_lastFile && now - m_lastAt < HEARTBEAT_EVERY_MS
            && !( aIsWrite && !m_lastWrite ) )
        {
            return;
        }

        m_lastFile = aFile;
        m_lastAt = now;
        m_lastWrite = aIsWrite;
    }

    bool stale;

    {
        std::lock_guard<std::mutex> lock( m_lock );
        stale = m_configReadAt == 0 || now - m_configReadAt > CONFIG_REREAD_MS;
    }

    if( stale )
        reloadConfig();

    send( aFile, aProject, LanguageOf( aFile ), aIsWrite, false, nullptr );
}


static std::string userAgent()
{
    wxString v = GetMajorMinorPatchVersion();
    wxString os;
#if defined( __WXMAC__ )
    os = wxT( "darwin" );
#elif defined( __WINDOWS__ )
    os = wxT( "windows" );
#else
    os = wxT( "linux" );
#endif
    return wxString::Format( wxT( "wakatime/v1.0.0 (%s) junction/%s junction-wakatime/%s" ), os, v, v )
            .ToStdString();
}


/// wakatime-cli's exit codes, in words.
static wxString cliStatus( long aCode )
{
    switch( aCode )
    {
    case 0: return _( "accepted (sent with wakatime-cli)" );
    case 102: return _( "the server could not be reached; wakatime-cli queued it to send later" );
    case 103: return _( "wakatime-cli could not read ~/.wakatime.cfg" );
    case 104: return _( "the API key was refused" );
    case 112: return _( "rate limited; wakatime-cli queued it to send later" );
    default: return wxString::Format( _( "wakatime-cli exited with code %ld" ), aCode );
    }
}


void WAKATIME::send( const wxString& aFile, const wxString& aProject, const wxString& aLanguage,
                     bool aIsWrite, bool aWait, wxString* aStatus, const wxString& aEntityType )
{
    CONFIG   cfg;
    wxString cli;

    {
        std::lock_guard<std::mutex> lock( m_lock );
        cfg = m_config;
        cli = m_cli;
    }

    if( !cfg.enabled )
        return;

    double time = wxGetUTCTimeMillis().GetValue() / 1000.0;

    if( !cli.IsEmpty() )
    {
        // wakatime-cli reads the key and server from the config itself, and keeps heartbeats
        // it could not send for later
        wxString plugin = wxString::FromUTF8( userAgent() ).AfterFirst( ' ' ).AfterFirst( ' ' );
        std::vector<wxString> args = { cli,
                                       wxT( "--entity" ), aFile,
                                       wxT( "--entity-type" ), aEntityType,
                                       wxT( "--category" ), wxT( "designing" ),
                                       wxT( "--language" ), aLanguage,
                                       wxT( "--plugin" ), plugin,
                                       wxT( "--time" ), wxString::Format( wxT( "%.3f" ), time ) };

        if( !aProject.IsEmpty() )
        {
            args.push_back( wxT( "--project" ) );
            args.push_back( aProject );
        }

        if( aIsWrite )
            args.push_back( wxT( "--write" ) );

        std::vector<const wxChar*> argv;

        for( const wxString& a : args )
            argv.push_back( a.wc_str() );

        argv.push_back( nullptr );

        if( aWait )
        {
            long code = wxExecute( argv.data(), wxEXEC_SYNC | wxEXEC_HIDE_CONSOLE | wxEXEC_NODISABLE );
            wxString status = cliStatus( code );

            {
                std::lock_guard<std::mutex> lock( m_lock );
                m_status = status;
            }

            if( aStatus )
                *aStatus = status;
        }
        else
        {
            wxExecute( argv.data(), wxEXEC_ASYNC | wxEXEC_HIDE_CONSOLE );
            std::lock_guard<std::mutex> lock( m_lock );
            m_status = _( "sent with wakatime-cli" );
        }

        return;
    }

    if( cfg.apiKey.IsEmpty() )
    {
        std::lock_guard<std::mutex> lock( m_lock );
        m_status = _( "no API key in ~/.wakatime.cfg" );

        if( aStatus )
            *aStatus = m_status;

        return;
    }

    nlohmann::json hb = { { "entity", aFile.ToStdString( wxConvUTF8 ) },
                          { "type", aEntityType.ToStdString() },
                          { "category", "designing" },
                          { "time", time },
                          { "project", aProject.ToStdString( wxConvUTF8 ) },
                          { "language", aLanguage.ToStdString( wxConvUTF8 ) },
                          { "is_write", aIsWrite },
                          { "editor", "Junction" },
                          { "plugin", "junction-wakatime/" + GetMajorMinorPatchVersion().ToStdString() },
                          { "operating_system", wxGetOsDescription().ToStdString( wxConvUTF8 ) },
                          { "machine", wxGetHostName().ToStdString( wxConvUTF8 ) },
                          { "user_agent", userAgent() } };

    // the bulk endpoint with a one-item array: WakaTime, Wakapi and Hackatime all take it
    std::string url = ( cfg.apiUrl.IsEmpty() ? wxString( DEFAULT_API_URL ) : cfg.apiUrl ).ToStdString()
                      + "/users/current/heartbeats.bulk";
    std::string body = nlohmann::json::array( { hb } ).dump();
    std::string key = cfg.apiKey.ToStdString( wxConvUTF8 );
    std::string auth = "Basic " + wxBase64Encode( key.data(), key.size() ).ToStdString();

    auto post = [this, url, body, auth]() -> wxString
    {
        wxString status;

        try
        {
            KICAD_CURL_EASY curl;
            curl.SetURL( url );
            curl.SetUserAgent( userAgent() );
            curl.SetHeader( "Authorization", auth );
            curl.SetHeader( "Content-Type", "application/json" );
            curl.SetConnectTimeout( 8 );
            curl.SetTimeout( 20 );
            curl.SetPostFields( body );
            int res = curl.Perform();
            int code = curl.GetResponseStatusCode();

            if( res != 0 )
                status = wxString::Format( _( "the server did not answer (%s)" ), curl.GetErrorText( res ) );
            else if( code >= 200 && code < 300 )
                status = wxString::Format( _( "accepted (%d)" ), code );
            else if( code == 401 || code == 403 )
                status = wxString::Format( _( "the API key was refused (%d)" ), code );
            else
                status = wxString::Format( _( "the server answered %d" ), code );
        }
        catch( ... )
        {
            status = _( "the heartbeat could not be sent" );
        }

        std::lock_guard<std::mutex> lock( m_lock );
        m_status = status;
        return status;
    };

    if( aWait )
    {
        wxString status = post();

        if( aStatus )
            *aStatus = status;
    }
    else
    {
        std::thread( post ).detach();
    }
}


bool WAKATIME::SendTest( wxString& aStatus )
{
    reloadConfig();

    CONFIG cfg;
    {
        std::lock_guard<std::mutex> lock( m_lock );
        cfg = m_config;
        // a test is sent even with heartbeats switched off
        m_config.enabled = true;
    }

    // an app heartbeat: wakatime-cli skips a "file" that does not exist on disk
    send( wxT( "Junction" ), wxT( "Junction" ), wxT( "KiCad" ), false, true, &aStatus, wxT( "app" ) );

    {
        std::lock_guard<std::mutex> lock( m_lock );
        m_config.enabled = cfg.enabled;
    }

    return aStatus.StartsWith( _( "accepted" ) );
}
