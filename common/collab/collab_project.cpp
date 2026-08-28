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
    wxArrayString files;
    wxDir::GetAllFiles( aProjectPath, &files, wxEmptyString, wxDIR_FILES );

    wxMemoryOutputStream memStream;
    int                  entries = 0;

    {
        wxZipOutputStream zipStream( memStream );

        for( size_t i = 0; i < files.GetCount(); ++i )
        {
            wxFileName fn( files[ i ] );
            wxString   ext = fn.GetExt().Lower();
            wxString   name = fn.GetFullName();

            bool wanted = ext == wxS( "kicad_pro" ) || ext == wxS( "kicad_sch" )
                          || ext == wxS( "kicad_pcb" ) || name == wxS( "sym-lib-table" )
                          || name == wxS( "fp-lib-table" );

            if( !wanted )
                continue;

            wxFFileInputStream input( files[ i ] );

            if( !input.IsOk() )
                continue;

            zipStream.PutNextEntry( name );
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

    int pos = input.Find( wxS( "/j/" ) );

    if( pos != wxNOT_FOUND )
        input = input.Mid( pos + 3 );

    // Strip any trailing URL components.
    input = input.BeforeFirst( '/' ).BeforeFirst( '?' ).BeforeFirst( '#' );

    return input;
}
