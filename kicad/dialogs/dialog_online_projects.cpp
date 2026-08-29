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

#include "dialog_online_projects.h"
#include "dialog_share_project.h"

#include <collab/collab_project.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>
#include <kicad_manager_frame.h>
#include <paths.h>
#include <project.h>

#include <wx/button.h>
#include <wx/clipbrd.h>
#include <wx/dataview.h>
#include <wx/dir.h>
#include <wx/dirdlg.h>
#include <wx/msgdlg.h>
#include <wx/sizer.h>
#include <wx/stattext.h>
#include <wx/textdlg.h>


/// "2026-08-28T17:03:12.345+00:00" -> "2026-08-28 17:03" (good enough for a list).
static wxString prettyTimestamp( const std::string& aRfc3339 )
{
    wxString ts = wxString::FromUTF8( aRfc3339 );

    if( ts.length() >= 16 )
    {
        ts = ts.Left( 16 );
        ts.Replace( wxS( "T" ), wxS( " " ) );
    }

    return ts;
}


/// A project name that is safe as a directory name.
static wxString sanitizeDirName( const wxString& aName )
{
    wxString out = aName;

    for( wxChar c : wxString( wxS( "/\\:*?\"<>|" ) ) )
        out.Replace( c, wxS( "_" ) );

    out.Trim( true ).Trim( false );

    return out.IsEmpty() ? wxString( wxS( "untitled" ) ) : out;
}


DIALOG_ONLINE_PROJECTS::DIALOG_ONLINE_PROJECTS( KICAD_MANAGER_FRAME* aParent ) :
        DIALOG_SHIM( aParent, wxID_ANY, _( "Online Projects" ), wxDefaultPosition,
                     wxSize( 760, 480 ), wxDEFAULT_DIALOG_STYLE | wxRESIZE_BORDER ),
        m_frame( aParent ),
        m_myUserId( -1 )
{
    wxBoxSizer* mainSizer = new wxBoxSizer( wxVERTICAL );

    // -- Sign-in row --------------------------------------------------------
    wxBoxSizer* authSizer = new wxBoxSizer( wxHORIZONTAL );

    m_signedInLabel = new wxStaticText( this, wxID_ANY, _( "Not signed in" ) );
    m_signInButton = new wxButton( this, wxID_ANY, _( "Sign In..." ) );
    wxButton* refreshButton = new wxButton( this, wxID_ANY, _( "Refresh" ) );

    authSizer->Add( m_signedInLabel, 1, wxALIGN_CENTER_VERTICAL | wxLEFT, 5 );
    authSizer->Add( refreshButton, 0, wxRIGHT, 5 );
    authSizer->Add( m_signInButton, 0, wxRIGHT, 5 );

    mainSizer->Add( authSizer, 0, wxEXPAND | wxALL, 5 );

    // -- Project list -------------------------------------------------------
    m_list = new wxDataViewListCtrl( this, wxID_ANY, wxDefaultPosition, wxDefaultSize,
                                     wxDV_ROW_LINES | wxDV_SINGLE );
    m_list->AppendTextColumn( _( "Name" ), wxDATAVIEW_CELL_INERT, 260 );
    m_list->AppendTextColumn( _( "Owner" ), wxDATAVIEW_CELL_INERT, 120 );
    m_list->AppendTextColumn( _( "Your Role" ), wxDATAVIEW_CELL_INERT, 90 );
    m_list->AppendTextColumn( _( "Visibility" ), wxDATAVIEW_CELL_INERT, 90 );
    m_list->AppendTextColumn( _( "Documents" ), wxDATAVIEW_CELL_INERT, 90 );
    m_list->AppendTextColumn( _( "Last Edited" ), wxDATAVIEW_CELL_INERT, 140 );

    mainSizer->Add( m_list, 1, wxEXPAND | wxLEFT | wxRIGHT, 10 );

    // -- Action buttons -----------------------------------------------------
    wxBoxSizer* buttonSizer = new wxBoxSizer( wxHORIZONTAL );

    m_openButton = new wxButton( this, wxID_ANY, _( "Open..." ) );
    m_shareButton = new wxButton( this, wxID_ANY, _( "Share..." ) );
    m_renameButton = new wxButton( this, wxID_ANY, _( "Rename..." ) );
    m_publicButton = new wxButton( this, wxID_ANY, _( "Make Public" ) );
    m_deleteButton = new wxButton( this, wxID_ANY, _( "Delete..." ) );
    wxButton* uploadButton = new wxButton( this, wxID_ANY, _( "Upload Current Project" ) );
    wxButton* joinButton = new wxButton( this, wxID_ANY, _( "Join from Link..." ) );

    buttonSizer->Add( m_openButton, 0, wxRIGHT, 5 );
    buttonSizer->Add( m_shareButton, 0, wxRIGHT, 5 );
    buttonSizer->Add( m_renameButton, 0, wxRIGHT, 5 );
    buttonSizer->Add( m_publicButton, 0, wxRIGHT, 5 );
    buttonSizer->Add( m_deleteButton, 0, wxRIGHT, 15 );
    buttonSizer->AddStretchSpacer();
    buttonSizer->Add( uploadButton, 0, wxRIGHT, 5 );
    buttonSizer->Add( joinButton, 0, wxRIGHT, 5 );

    mainSizer->Add( buttonSizer, 0, wxEXPAND | wxALL, 10 );

    mainSizer->Add( CreateStdDialogButtonSizer( wxCLOSE ), 0, wxEXPAND | wxALL, 5 );

    SetSizer( mainSizer );

    m_signInButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onSignInOut, this );
    refreshButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onRefresh, this );
    m_openButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onOpen, this );
    m_shareButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onShare, this );
    m_renameButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onRename, this );
    m_publicButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onTogglePublic, this );
    m_deleteButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onDelete, this );
    uploadButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onUpload, this );
    joinButton->Bind( wxEVT_BUTTON, &DIALOG_ONLINE_PROJECTS::onJoinLink, this );
    m_list->Bind( wxEVT_DATAVIEW_ITEM_ACTIVATED, &DIALOG_ONLINE_PROJECTS::onItemActivated, this );

    m_openButton->Bind( wxEVT_UPDATE_UI, &DIALOG_ONLINE_PROJECTS::onUpdateUI, this );
    m_shareButton->Bind( wxEVT_UPDATE_UI, &DIALOG_ONLINE_PROJECTS::onUpdateUI, this );
    m_renameButton->Bind( wxEVT_UPDATE_UI, &DIALOG_ONLINE_PROJECTS::onUpdateUI, this );
    m_publicButton->Bind( wxEVT_UPDATE_UI, &DIALOG_ONLINE_PROJECTS::onUpdateUI, this );
    m_deleteButton->Bind( wxEVT_UPDATE_UI, &DIALOG_ONLINE_PROJECTS::onUpdateUI, this );

    finishDialogSettings();

    refresh();
}


void DIALOG_ONLINE_PROJECTS::updateSignInState()
{
    if( m_myLogin.IsEmpty() )
    {
        m_signedInLabel->SetLabel( _( "Not signed in" ) );
        m_signInButton->SetLabel( _( "Sign In..." ) );
    }
    else
    {
        m_signedInLabel->SetLabel( wxString::Format( _( "Signed in as %s  —  %s" ), m_myLogin,
                                                     COLLAB_SESSION::ServerUrl() ) );
        m_signInButton->SetLabel( _( "Sign Out" ) );
    }
}


void DIALOG_ONLINE_PROJECTS::refresh()
{
    wxString server = COLLAB_SESSION::ServerUrl();
    wxString token = COLLAB_AUTH::StoredToken( server );

    m_list->DeleteAllItems();
    m_projects.clear();
    m_myLogin.clear();
    m_myUserId = -1;

    if( token.IsEmpty() )
    {
        updateSignInState();
        return;
    }

    if( std::optional<nlohmann::json> me = COLLAB_REST::Me( server, token ) )
    {
        m_myLogin = wxString::FromUTF8( me->value( "login", "" ) );
        m_myUserId = me->value( "id", -1LL );
    }

    updateSignInState();

    std::optional<nlohmann::json> listing = COLLAB_REST::ListProjects( server, token );

    if( !listing || !listing->contains( "projects" ) )
        return;

    for( const nlohmann::json& project : ( *listing )[ "projects" ] )
    {
        wxVector<wxVariant> row;
        row.push_back( wxVariant( wxString::FromUTF8( project.value( "name", "" ) ) ) );

        wxString owner = wxString::FromUTF8( project.value( "ownerLogin", "" ) );

        if( project.value( "ownerId", -1LL ) == m_myUserId )
            owner = _( "you" );

        row.push_back( wxVariant( owner ) );
        row.push_back( wxVariant( wxString::FromUTF8( project.value( "role", "" ) ) ) );
        row.push_back( wxVariant( project.value( "public", false ) ? _( "public" )
                                                                   : _( "private" ) ) );
        row.push_back( wxVariant( wxString::Format( wxS( "%lld" ),
                                                    project.value( "docCount", 0LL ) ) ) );
        row.push_back( wxVariant( prettyTimestamp( project.value( "updatedAt", "" ) ) ) );

        m_list->AppendItem( row );
        m_projects.push_back( project );
    }
}


const nlohmann::json* DIALOG_ONLINE_PROJECTS::selectedProject() const
{
    int row = m_list->GetSelectedRow();

    if( row == wxNOT_FOUND || row < 0 || row >= (int) m_projects.size() )
        return nullptr;

    return &m_projects[ row ];
}


bool DIALOG_ONLINE_PROJECTS::ownsSelected() const
{
    const nlohmann::json* project = selectedProject();

    return project && project->value( "ownerId", -1LL ) == m_myUserId;
}


void DIALOG_ONLINE_PROJECTS::onUpdateUI( wxUpdateUIEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( aEvent.GetEventObject() == m_openButton )
    {
        aEvent.Enable( project != nullptr );
    }
    else if( aEvent.GetEventObject() == m_publicButton )
    {
        aEvent.Enable( ownsSelected() );

        if( project )
        {
            aEvent.SetText( project->value( "public", false ) ? _( "Make Private" )
                                                              : _( "Make Public" ) );
        }
    }
    else
    {
        aEvent.Enable( ownsSelected() );
    }
}


void DIALOG_ONLINE_PROJECTS::onSignInOut( wxCommandEvent& aEvent )
{
    wxString server = COLLAB_SESSION::ServerUrl();

    if( !m_myLogin.IsEmpty() )
    {
        COLLAB_AUTH::ForgetToken( server );
        refresh();
        return;
    }

    wxString error;

    bool started = m_auth.SignIn( server,
            [this]( bool aSuccess, const wxString& aTokenOrError )
            {
                if( aSuccess )
                    refresh();
                else
                    wxMessageBox( aTokenOrError, _( "Sign In" ), wxOK | wxICON_ERROR, this );
            },
            error );

    if( !started )
        wxMessageBox( error, _( "Sign In" ), wxOK | wxICON_ERROR, this );
}


void DIALOG_ONLINE_PROJECTS::onRefresh( wxCommandEvent& aEvent )
{
    refresh();
}


void DIALOG_ONLINE_PROJECTS::onItemActivated( wxDataViewEvent& aEvent )
{
    if( const nlohmann::json* project = selectedProject() )
        openProject( *project );
}


void DIALOG_ONLINE_PROJECTS::onOpen( wxCommandEvent& aEvent )
{
    if( const nlohmann::json* project = selectedProject() )
        openProject( *project );
}


void DIALOG_ONLINE_PROJECTS::openProject( const nlohmann::json& aProject )
{
    wxString server = COLLAB_SESSION::ServerUrl();
    wxString token = COLLAB_AUTH::StoredToken( server );
    wxString projectId = wxString::FromUTF8( aProject.value( "projectId", "" ) );
    wxString name = wxString::FromUTF8( aProject.value( "name", "untitled" ) );

    if( token.IsEmpty() || projectId.IsEmpty() )
        return;

    // Opened before?  Reuse the recorded copy without asking for a directory
    // or downloading anything; local edits replay from the journal on join.
    wxString recorded = COLLAB_PROJECT::FindLocalCopy( projectId );

    if( !recorded.IsEmpty() )
    {
        m_projectToOpen = recorded;
        EndModal( wxID_OK );
        return;
    }

    // Default local home for cloud copies; the user can put it elsewhere.
    wxFileName base( PATHS::GetDefaultUserProjectsPath(), wxEmptyString );
    base.AppendDir( wxS( "Cloud" ) );

    wxDirDialog dirDlg( this, _( "Folder to store the local copy in" ), base.GetPath(),
                        wxDD_DEFAULT_STYLE );

    if( dirDlg.ShowModal() != wxID_OK )
        return;

    wxFileName target( dirDlg.GetPath(), wxEmptyString );
    target.AppendDir( sanitizeDirName( name ) );

    // Re-opening an existing local copy: skip the download, keep local edits
    // (they replay from the journal when the session reconnects).
    wxString  existingServer;
    wxString  existingId =
            COLLAB_PROJECT::ReadLocalLink( target.GetPath(), sanitizeDirName( name ),
                                           existingServer );

    if( existingId == projectId )
    {
        wxArrayString proFiles;
        wxDir::GetAllFiles( target.GetPath(), &proFiles, wxS( "*.kicad_pro" ), wxDIR_FILES );

        if( !proFiles.IsEmpty() )
        {
            COLLAB_PROJECT::RecordLocalCopy( projectId, proFiles[ 0 ] );
            m_projectToOpen = proFiles[ 0 ];
            EndModal( wxID_OK );
            return;
        }
    }

    wxString proFile;
    wxString error;

    if( !COLLAB_PROJECT::DownloadAndExtract( server, token, projectId, sanitizeDirName( name ),
                                             target.GetPath(), proFile, error ) )
    {
        wxMessageBox( error, _( "Open Online Project" ), wxOK | wxICON_ERROR, this );
        return;
    }

    if( proFile.IsEmpty() )
    {
        wxMessageBox( _( "The project contains no .kicad_pro file." ),
                      _( "Open Online Project" ), wxOK | wxICON_ERROR, this );
        return;
    }

    COLLAB_PROJECT::RecordLocalCopy( projectId, proFile );
    m_projectToOpen = proFile;
    EndModal( wxID_OK );
}


void DIALOG_ONLINE_PROJECTS::onShare( wxCommandEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( !project )
        return;

    DIALOG_SHARE_PROJECT dlg( this, wxString::FromUTF8( project->value( "projectId", "" ) ),
                              wxString::FromUTF8( project->value( "name", "" ) ) );
    dlg.ShowModal();
}


void DIALOG_ONLINE_PROJECTS::onRename( wxCommandEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( !project )
        return;

    wxString          current = wxString::FromUTF8( project->value( "name", "" ) );
    wxTextEntryDialog dlg( this, _( "New project name:" ), _( "Rename Online Project" ),
                           current );

    if( dlg.ShowModal() != wxID_OK || dlg.GetValue().Trim().IsEmpty() )
        return;

    wxString server = COLLAB_SESSION::ServerUrl();

    if( !COLLAB_REST::RenameProject( server, COLLAB_AUTH::StoredToken( server ),
                                     wxString::FromUTF8( project->value( "projectId", "" ) ),
                                     dlg.GetValue().Trim() ) )
    {
        wxMessageBox( _( "Renaming the project failed." ), _( "Rename Online Project" ),
                      wxOK | wxICON_ERROR, this );
    }

    refresh();
}


void DIALOG_ONLINE_PROJECTS::onTogglePublic( wxCommandEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( !project )
        return;

    bool     makePublic = !project->value( "public", false );
    wxString name = wxString::FromUTF8( project->value( "name", "" ) );

    if( makePublic
        && wxMessageBox( wxString::Format( _( "Make '%s' public?\n\nIt will appear in the "
                                              "server's gallery and anyone signed in can view "
                                              "it.  Members keep their existing roles." ),
                                           name ),
                         _( "Make Project Public" ), wxYES_NO | wxICON_QUESTION, this )
                   != wxYES )
    {
        return;
    }

    wxString server = COLLAB_SESSION::ServerUrl();

    if( !COLLAB_REST::SetProjectPublic( server, COLLAB_AUTH::StoredToken( server ),
                                        wxString::FromUTF8( project->value( "projectId", "" ) ),
                                        makePublic ) )
    {
        wxMessageBox( _( "Updating the project visibility failed." ),
                      _( "Project Visibility" ), wxOK | wxICON_ERROR, this );
    }

    refresh();
}


void DIALOG_ONLINE_PROJECTS::onDelete( wxCommandEvent& aEvent )
{
    const nlohmann::json* project = selectedProject();

    if( !project )
        return;

    wxString name = wxString::FromUTF8( project->value( "name", "" ) );

    if( wxMessageBox( wxString::Format( _( "Delete the online project '%s'?\n\n"
                                           "This removes it from the server for every "
                                           "collaborator.  Local copies are not touched." ),
                                        name ),
                      _( "Delete Online Project" ), wxYES_NO | wxICON_WARNING, this )
        != wxYES )
    {
        return;
    }

    wxString server = COLLAB_SESSION::ServerUrl();

    if( !COLLAB_REST::DeleteProject( server, COLLAB_AUTH::StoredToken( server ),
                                     wxString::FromUTF8( project->value( "projectId", "" ) ) ) )
    {
        wxMessageBox( _( "Deleting the project failed." ), _( "Delete Online Project" ),
                      wxOK | wxICON_ERROR, this );
    }

    refresh();
}


void DIALOG_ONLINE_PROJECTS::onUpload( wxCommandEvent& aEvent )
{
    wxString projectPath = m_frame->Prj().GetProjectPath();
    wxString projectName = m_frame->Prj().GetProjectName();

    if( projectPath.IsEmpty() || projectName.IsEmpty() )
    {
        wxMessageBox( _( "Open a local project first." ), _( "Upload Project" ),
                      wxOK | wxICON_INFORMATION, this );
        return;
    }

    wxString server = COLLAB_SESSION::ServerUrl();
    wxString token = COLLAB_AUTH::StoredToken( server );

    if( token.IsEmpty() )
    {
        wxMessageBox( _( "Sign in first." ), _( "Upload Project" ), wxOK | wxICON_INFORMATION,
                      this );
        return;
    }

    wxString url;
    wxString error;

    std::optional<nlohmann::json> project =
            COLLAB_PROJECT::CreateAndShare( server, token, projectPath, projectName, url,
                                            error );

    if( !project )
    {
        wxMessageBox( error, _( "Upload Project" ), wxOK | wxICON_ERROR, this );
        return;
    }

    // Remember the pairing so the editors auto-join the live session.
    COLLAB_PROJECT::WriteLocalLink( projectPath, projectName, server,
                                    wxString::FromUTF8( project->value( "projectId", "" ) ) );

    if( wxTheClipboard->Open() )
    {
        wxTheClipboard->SetData( new wxTextDataObject( url ) );
        wxTheClipboard->Close();
    }

    wxMessageBox( wxString::Format( _( "Project uploaded.  Share link copied to the "
                                       "clipboard:\n%s" ),
                                    url ),
                  _( "Upload Project" ), wxOK | wxICON_INFORMATION, this );

    refresh();
}


void DIALOG_ONLINE_PROJECTS::onJoinLink( wxCommandEvent& aEvent )
{
    wxTextEntryDialog dlg( this, _( "Share link or invite token:" ), _( "Join Shared Project" ) );

    if( dlg.ShowModal() != wxID_OK )
        return;

    wxString linkToken = COLLAB_PROJECT::ParseLinkToken( dlg.GetValue() );

    if( linkToken.IsEmpty() )
    {
        wxMessageBox( _( "The share link could not be understood." ), _( "Join Shared Project" ),
                      wxOK | wxICON_ERROR, this );
        return;
    }

    wxString server = COLLAB_SESSION::ServerUrl();
    wxString token = COLLAB_AUTH::StoredToken( server );

    if( token.IsEmpty() )
    {
        wxMessageBox( _( "Sign in first." ), _( "Join Shared Project" ),
                      wxOK | wxICON_INFORMATION, this );
        return;
    }

    wxString error;

    std::optional<nlohmann::json> project =
            COLLAB_PROJECT::ClaimAndFetch( server, token, linkToken, error );

    if( !project )
    {
        wxMessageBox( error, _( "Join Shared Project" ), wxOK | wxICON_ERROR, this );
        return;
    }

    refresh();

    // Offer to pull a local copy right away.
    nlohmann::json listingLike = {
        { "projectId", project->value( "projectId", "" ) },
        { "name", project->value( "name", "" ) },
    };

    if( wxMessageBox( wxString::Format( _( "Joined '%s'.  Download a local copy and open "
                                           "it now?" ),
                                        wxString::FromUTF8( project->value( "name", "" ) ) ),
                      _( "Join Shared Project" ), wxYES_NO | wxICON_QUESTION, this )
        == wxYES )
    {
        openProject( listingLike );
    }
}
