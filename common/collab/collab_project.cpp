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

#include <collab/collab_project.h>

#include <collab/collab_rest.h>

#include <wx/dir.h>
#include <wx/filename.h>
#include <wx/mstream.h>
#include <wx/translation.h>
#include <wx/wfstream.h>
#include <wx/zipstrm.h>


std::string COLLAB_PROJECT::ZipProjectFiles( const wxString& aProjectPath )
{
    // Recurse: hierarchical projects keep sub-sheets in subdirectories.  The
    // extension whitelist keeps backups, journals and outputs out of the upload.
    wxArrayString files;
    wxDir::GetAllFiles( aProjectPath, &files, wxEmptyString, wxDIR_FILES | wxDIR_DIRS );

    wxMemoryOutputStream memStream;
    int                  entries = 0;

    {
        wxZipOutputStream zipStream( memStream );

        for( size_t i = 0; i < files.GetCount(); ++i )
        {
            wxFileName fn( files[ i ] );
            wxString   ext = fn.GetExt().Lower();
            wxString   name = fn.GetFullName();

            // Design files, project-local libraries (.kicad_sym, .pretty footprints),
            // 3D models and library tables all travel with the project; the type is
            // detected from the extension here and again on the server.
            bool wanted = ext == wxS( "kicad_pro" ) || ext == wxS( "kicad_sch" )
                          || ext == wxS( "kicad_pcb" ) || ext == wxS( "kicad_sym" )
                          || ext == wxS( "kicad_mod" ) || ext == wxS( "kicad_dru" )
                          || ext == wxS( "kicad_wks" ) || ext == wxS( "step" )
                          || ext == wxS( "stp" ) || ext == wxS( "wrl" ) || ext == wxS( "wrz" )
                          || name == wxS( "sym-lib-table" ) || name == wxS( "fp-lib-table" )
                          || name == wxS( "design-block-lib-table" );

            if( !wanted )
                continue;

            // Store the project-relative path (forward slashes) so sub-sheets
            // land where the peer's document map expects them.
            wxFileName rel( files[ i ] );
            rel.MakeRelativeTo( aProjectPath );
            wxString entryName = rel.GetFullPath( wxPATH_UNIX );

            wxFFileInputStream input( files[ i ] );

            if( !input.IsOk() )
                continue;

            zipStream.PutNextEntry( entryName );
            zipStream.Write( input );
            entries++;
        }

        if( !zipStream.Close() || entries == 0 )
            return std::string();
    }

    size_t size = memStream.GetSize();

    if( size == 0 )
        return std::string();

    std::string bytes;
    bytes.resize( size );
    memStream.CopyTo( bytes.data(), size );

    return bytes;
}


std::optional<nlohmann::json> COLLAB_PROJECT::CreateAndShare( const wxString& aServer,
                                                              const wxString& aToken,
                                                              const wxString& aProjectPath,
                                                              const wxString& aProjectName,
                                                              wxString& aShareUrl,
                                                              wxString& aError )
{
    std::string zipBytes = ZipProjectFiles( aProjectPath );

    if( zipBytes.empty() )
    {
        aError = _( "No project files found to share.  Save the project first." );
        return std::nullopt;
    }

    std::optional<nlohmann::json> project =
            COLLAB_REST::CreateProject( aServer, aToken, aProjectName, zipBytes );

    if( !project )
    {
        aError = _( "Uploading the project to the collaboration server failed." );
        return std::nullopt;
    }

    wxString projectId = wxString::FromUTF8( project->value( "projectId", "" ) );

    std::optional<nlohmann::json> link =
            COLLAB_REST::CreateShareLink( aServer, aToken, projectId, wxS( "editor" ) );

    if( !link )
    {
        aError = _( "Creating the share link failed." );
        return std::nullopt;
    }

    aShareUrl = wxString::FromUTF8( link->value( "url", "" ) );

    return project;
}


std::optional<nlohmann::json> COLLAB_PROJECT::ClaimAndFetch( const wxString& aServer,
                                                             const wxString& aToken,
                                                             const wxString& aLinkToken,
                                                             wxString& aError )
{
    std::optional<nlohmann::json> claim = COLLAB_REST::ClaimLink( aServer, aToken, aLinkToken );

    if( !claim )
    {
        aError = _( "The share link is invalid or has expired." );
        return std::nullopt;
    }

    wxString projectId = wxString::FromUTF8( claim->value( "projectId", "" ) );

    std::optional<nlohmann::json> project = COLLAB_REST::GetProject( aServer, aToken, projectId );

    if( !project )
    {
        aError = _( "Unable to fetch the shared project." );
        return std::nullopt;
    }

    return project;
}


wxString COLLAB_PROJECT::ParseLinkToken( const wxString& aInput )
{
    wxString input = aInput;
    input.Trim( true ).Trim( false );

    // The web landing page's "Open in KiCad" button uses this scheme.
    if( input.StartsWith( wxS( "kicad-collab://join/" ) ) )
        input = input.Mid( wxString( wxS( "kicad-collab://join/" ) ).length() );

    int pos = input.Find( wxS( "/j/" ) );

    if( pos != wxNOT_FOUND )
        input = input.Mid( pos + 3 );

    // Strip any trailing URL components.
    input = input.BeforeFirst( '/' ).BeforeFirst( '?' ).BeforeFirst( '#' );

    return input;
}


static wxString localLinkPath( const wxString& aProjectPath, const wxString& aProjectName )
{
    wxFileName dir( aProjectPath, wxEmptyString );
    dir.AppendDir( aProjectName + wxS( ".collab" ) );

    return wxFileName( dir.GetPath(), wxS( "link.json" ) ).GetFullPath();
}


void COLLAB_PROJECT::WriteLocalLink( const wxString& aProjectPath, const wxString& aProjectName,
                                     const wxString& aServer, const wxString& aProjectId )
{
    wxFileName file( localLinkPath( aProjectPath, aProjectName ) );

    if( !file.DirExists() && !wxFileName::Mkdir( file.GetPath(), wxS_DIR_DEFAULT,
                                                 wxPATH_MKDIR_FULL ) )
        return;

    nlohmann::json link = {
        { "server", aServer.ToStdString( wxConvUTF8 ) },
        { "projectId", aProjectId.ToStdString( wxConvUTF8 ) },
    };

    wxFFileOutputStream out( file.GetFullPath() );

    if( out.IsOk() )
    {
        std::string text = link.dump( 2 );
        out.Write( text.data(), text.size() );
    }
}


wxString COLLAB_PROJECT::ReadLocalLink( const wxString& aProjectPath,
                                        const wxString& aProjectName, wxString& aServer )
{
    wxFileName file( localLinkPath( aProjectPath, aProjectName ) );

    if( !file.FileExists() )
        return wxEmptyString;

    wxFFileInputStream in( file.GetFullPath() );

    if( !in.IsOk() )
        return wxEmptyString;

    std::string text;
    text.resize( in.GetLength() );
    in.Read( text.data(), text.size() );

    try
    {
        nlohmann::json link = nlohmann::json::parse( text );

        aServer = wxString::FromUTF8( link.value( "server", "" ) );
        return wxString::FromUTF8( link.value( "projectId", "" ) );
    }
    catch( ... )
    {
        return wxEmptyString;
    }
}


bool COLLAB_PROJECT::DownloadAndExtract( const wxString& aServer, const wxString& aToken,
                                         const wxString& aProjectId,
                                         const wxString& aProjectName,
                                         const wxString& aTargetDir, wxString& aProFile,
                                         wxString& aError )
{
    aProFile.clear();

    std::optional<std::string> archive =
            COLLAB_REST::DownloadArchive( aServer, aToken, aProjectId );

    if( !archive )
    {
        aError = _( "Unable to download the shared project." );
        return false;
    }

    if( !wxFileName::DirExists( aTargetDir )
        && !wxFileName::Mkdir( aTargetDir, wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
    {
        aError = _( "Unable to create the project directory." );
        return false;
    }

    wxMemoryInputStream memStream( archive->data(), archive->size() );
    wxZipInputStream    zipStream( memStream );

    std::unique_ptr<wxZipEntry> entry;

    while( entry.reset( zipStream.GetNextEntry() ), entry )
    {
        if( entry->IsDir() )
            continue;

        // The server sanitizes uploads, but never trust archive paths anyway.
        wxString name = entry->GetName( wxPATH_UNIX );

        if( name.IsEmpty() || name.StartsWith( wxS( "/" ) ) || name.Contains( wxS( ".." ) )
            || name.Contains( wxS( ":" ) ) )
            continue;

        wxFileName target( aTargetDir + wxFileName::GetPathSeparator()
                           + wxFileName( name, wxPATH_UNIX ).GetFullPath() );

        if( !target.DirExists()
            && !wxFileName::Mkdir( target.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
            continue;

        wxFFileOutputStream out( target.GetFullPath() );

        if( !out.IsOk() )
            continue;

        zipStream.Read( out );

        if( target.GetExt() == wxS( "kicad_pro" ) && aProFile.IsEmpty() )
            aProFile = target.GetFullPath();
    }

    WriteLocalLink( aTargetDir, aProjectName, aServer, aProjectId );

    return true;
}
