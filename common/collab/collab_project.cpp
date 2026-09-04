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
#include <paths.h>

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

    // What was just uploaded is the online project: base the merge on it.
    SeedSyncBases( aProjectPath, aProjectName );

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


static wxString collabDirPath( const wxString& aProjectPath, const wxString& aProjectName )
{
    wxFileName dir( aProjectPath, wxEmptyString );
    dir.AppendDir( aProjectName + wxS( ".collab" ) );

    return dir.GetPath();
}


static wxString localLinkPath( const wxString& aProjectPath, const wxString& aProjectName )
{
    return wxFileName( collabDirPath( aProjectPath, aProjectName ), wxS( "link.json" ) )
            .GetFullPath();
}


/// <project>.collab/base/<aRelPath>, or empty for a path that climbs out of it.
static wxString syncBasePath( const wxString& aProjectPath, const wxString& aProjectName,
                              const wxString& aRelPath )
{
    if( aRelPath.IsEmpty() )
        return wxEmptyString;

    wxFileName rel( aRelPath, wxPATH_UNIX );
    wxFileName file( collabDirPath( aProjectPath, aProjectName ), wxEmptyString );
    file.AppendDir( wxS( "base" ) );

    for( const wxString& dir : rel.GetDirs() )
    {
        if( dir == wxS( ".." ) )
            return wxEmptyString;

        file.AppendDir( dir );
    }

    file.SetFullName( rel.GetFullName() );

    return file.GetFullPath();
}


static std::string readWholeFile( const wxString& aPath )
{
    if( aPath.IsEmpty() || !wxFileName::FileExists( aPath ) )
        return std::string();

    wxFFileInputStream in( aPath );

    if( !in.IsOk() )
        return std::string();

    std::string text;
    text.resize( in.GetLength() );
    in.Read( text.data(), text.size() );

    return text;
}


void COLLAB_PROJECT::WriteSyncBase( const wxString& aProjectPath, const wxString& aProjectName,
                                    const wxString& aRelPath, const std::string& aText )
{
    wxFileName file( syncBasePath( aProjectPath, aProjectName, aRelPath ) );

    if( file.GetFullPath().IsEmpty() )
        return;

    if( !file.DirExists()
        && !wxFileName::Mkdir( file.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL ) )
    {
        return;
    }

    wxFFileOutputStream out( file.GetFullPath() );

    if( out.IsOk() )
        out.Write( aText.data(), aText.size() );
}


std::string COLLAB_PROJECT::ReadSyncBase( const wxString& aProjectPath,
                                          const wxString& aProjectName,
                                          const wxString& aRelPath )
{
    return readWholeFile( syncBasePath( aProjectPath, aProjectName, aRelPath ) );
}


void COLLAB_PROJECT::RefreshSyncBaseFromDisk( const wxString& aProjectPath,
                                              const wxString& aProjectName,
                                              const wxString& aRelPath )
{
    wxFileName doc( aProjectPath + wxFileName::GetPathSeparator()
                    + wxFileName( aRelPath, wxPATH_UNIX ).GetFullPath() );

    std::string text = readWholeFile( doc.GetFullPath() );

    if( !text.empty() )
        WriteSyncBase( aProjectPath, aProjectName, aRelPath, text );
}


void COLLAB_PROJECT::SeedSyncBases( const wxString& aProjectPath, const wxString& aProjectName )
{
    wxArrayString files;
    wxDir::GetAllFiles( aProjectPath, &files, wxEmptyString, wxDIR_FILES | wxDIR_DIRS );

    for( const wxString& path : files )
    {
        wxFileName fn( path );
        wxString   ext = fn.GetExt().Lower();

        if( ext != wxS( "kicad_pcb" ) && ext != wxS( "kicad_sch" ) )
            continue;

        wxFileName rel( path );
        rel.MakeRelativeTo( aProjectPath );

        // Not the copies inside .collab/base itself, backups, or local history.
        bool skip = false;

        for( const wxString& dir : rel.GetDirs() )
        {
            if( dir.EndsWith( wxS( ".collab" ) ) || dir.EndsWith( wxS( "-backups" ) )
                || dir.StartsWith( wxS( "." ) ) )
            {
                skip = true;
                break;
            }
        }

        if( !skip )
            RefreshSyncBaseFromDisk( aProjectPath, aProjectName, rel.GetFullPath( wxPATH_UNIX ) );
    }
}


void COLLAB_PROJECT::UnlinkLocalProject( const wxString& aProjectPath,
                                         const wxString& aProjectName )
{
    wxString server;
    wxString projectId = ReadLocalLink( aProjectPath, aProjectName, server );

    if( !projectId.IsEmpty() )
        ForgetLocalCopy( projectId );

    wxString dir = collabDirPath( aProjectPath, aProjectName );

    if( wxFileName::DirExists( dir ) )
        wxFileName::Rmdir( dir, wxPATH_RMDIR_RECURSIVE );
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


static wxString localCopiesPathIn( const wxString& aRegistryDir )
{
    return wxFileName( aRegistryDir, wxS( "collab-local-copies.json" ) ).GetFullPath();
}


void COLLAB_PROJECT::RecordLocalCopy( const wxString& aProjectId, const wxString& aProFile )
{
    RecordLocalCopyIn( PATHS::GetUserSettingsPath(), aProjectId, aProFile );
}


wxString COLLAB_PROJECT::FindLocalCopy( const wxString& aProjectId )
{
    return FindLocalCopyIn( PATHS::GetUserSettingsPath(), aProjectId );
}


void COLLAB_PROJECT::ForgetLocalCopy( const wxString& aProjectId )
{
    ForgetLocalCopyIn( PATHS::GetUserSettingsPath(), aProjectId );
}


void COLLAB_PROJECT::ForgetLocalCopyIn( const wxString& aRegistryDir, const wxString& aProjectId )
{
    std::string text = readWholeFile( localCopiesPathIn( aRegistryDir ) );

    if( text.empty() )
        return;

    nlohmann::json map;

    try
    {
        map = nlohmann::json::parse( text );
    }
    catch( ... )
    {
        return;
    }

    if( !map.is_object() || !map.contains( aProjectId.ToStdString( wxConvUTF8 ) ) )
        return;

    map.erase( aProjectId.ToStdString( wxConvUTF8 ) );

    wxFFileOutputStream out( localCopiesPathIn( aRegistryDir ) );

    if( out.IsOk() )
    {
        std::string dump = map.dump( 2 );
        out.Write( dump.data(), dump.size() );
    }
}


void COLLAB_PROJECT::RecordLocalCopyIn( const wxString& aRegistryDir, const wxString& aProjectId,
                                        const wxString& aProFile )
{
    nlohmann::json map = nlohmann::json::object();

    if( wxFileName::FileExists( localCopiesPathIn( aRegistryDir ) ) )
    {
        wxFFileInputStream in( localCopiesPathIn( aRegistryDir ) );

        if( in.IsOk() )
        {
            std::string text;
            text.resize( in.GetLength() );
            in.Read( text.data(), text.size() );

            try
            {
                map = nlohmann::json::parse( text );
            }
            catch( ... )
            {
                map = nlohmann::json::object();
            }
        }
    }

    if( !map.is_object() )
        map = nlohmann::json::object();

    map[ aProjectId.ToStdString( wxConvUTF8 ) ] = aProFile.ToStdString( wxConvUTF8 );

    wxFFileOutputStream out( localCopiesPathIn( aRegistryDir ) );

    if( out.IsOk() )
    {
        std::string text = map.dump( 2 );
        out.Write( text.data(), text.size() );
    }
}


wxString COLLAB_PROJECT::FindLocalCopyIn( const wxString& aRegistryDir,
                                          const wxString& aProjectId )
{
    if( !wxFileName::FileExists( localCopiesPathIn( aRegistryDir ) ) )
        return wxEmptyString;

    wxFFileInputStream in( localCopiesPathIn( aRegistryDir ) );

    if( !in.IsOk() )
        return wxEmptyString;

    std::string text;
    text.resize( in.GetLength() );
    in.Read( text.data(), text.size() );

    wxString proFile;

    try
    {
        nlohmann::json map = nlohmann::json::parse( text );

        if( !map.is_object() )
            return wxEmptyString;

        proFile = wxString::FromUTF8(
                map.value( aProjectId.ToStdString( wxConvUTF8 ), std::string() ) );
    }
    catch( ... )
    {
        return wxEmptyString;
    }

    if( proFile.IsEmpty() || !wxFileName::FileExists( proFile ) )
        return wxEmptyString;

    // The directory must still be linked to this project: a moved or
    // repurposed copy must not be silently reused.
    wxFileName pro( proFile );
    wxString   server;
    wxString   linkedId = ReadLocalLink( pro.GetPath(), pro.GetName(), server );

    if( linkedId != aProjectId )
        return wxEmptyString;

    return proFile;
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

    // Pair the copy with the online project where the editors look for it:
    // beside the .kicad_pro, under that file's name (the online name can
    // differ, e.g. after a rename).  The download is the online state, so it
    // is also the base for the next merge.
    wxString linkDir = aTargetDir;
    wxString linkName = aProjectName;

    if( !aProFile.IsEmpty() )
    {
        wxFileName pro( aProFile );
        linkDir = pro.GetPath();
        linkName = pro.GetName();
    }

    WriteLocalLink( linkDir, linkName, aServer, aProjectId );
    SeedSyncBases( linkDir, linkName );

    return true;
}
