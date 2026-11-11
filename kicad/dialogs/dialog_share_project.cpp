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

#include "dialog_share_project.h"

#include <atomic>
#include <iterator>
#include <optional>
#include <string>

#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>

#include <wx/app.h>
#include <wx/button.h>
#include <wx/checkbox.h>
#include <wx/choice.h>
#include <wx/clipbrd.h>
#include <wx/dataobj.h>
#include <wx/dataview.h>
#include <wx/listbox.h>
#include <wx/msgdlg.h>
#include <wx/sizer.h>
#include <wx/statbox.h>
#include <wx/stattext.h>
#include <wx/textctrl.h>

/// Debounce for the user-search typeahead.
static constexpr int SEARCH_DELAY_MS = 350;

/// What the entries of the link expiry choice mean, in days; 0 never expires.
static constexpr int LINK_EXPIRY_DAYS[] = { 0, 1, 7, 30 };


/// A string member of a JSON object, or empty when it is missing, null or not a string.
static wxString jsonStr( const nlohmann::json& aObject, const char* aKey )
{
    if( !aObject.is_object() )
        return wxEmptyString;

    auto it = aObject.find( aKey );

    if( it == aObject.end() || !it->is_string() )
        return wxEmptyString;

    return wxString::FromUTF8( it->get<std::string>() );
}


/// An integer member of a JSON object, or aDefault.
static long long jsonInt( const nlohmann::json& aObject, const char* aKey, long long aDefault )
{
    if( !aObject.is_object() )
        return aDefault;

    auto it = aObject.find( aKey );

    if( it == aObject.end() || !it->is_number_integer() )
        return aDefault;

    return it->get<long long>();
}


/// A boolean member of a JSON object, or false.
static bool jsonBool( const nlohmann::json& aObject, const char* aKey )
{
    if( !aObject.is_object() )
        return false;

    auto it = aObject.find( aKey );

    return it != aObject.end() && it->is_boolean() && it->get<bool>();
}


/// An array member of a JSON object, or an empty array.
static nlohmann::json jsonArray( const nlohmann::json& aObject, const char* aKey )
{
    if( aObject.is_object() )
    {
        auto it = aObject.find( aKey );

        if( it != aObject.end() && it->is_array() )
            return *it;
    }

    return nlohmann::json::array();
}


/// "2026-08-28T17:03:12.345+00:00" -> "2026-08-28 17:03" (good enough for a list).
static wxString prettyTimestamp( const wxString& aRfc3339 )
{
    wxString ts = aRfc3339;

    if( ts.length() >= 16 )
    {
        ts = ts.Left( 16 );
        ts.Replace( wxS( "T" ), wxS( " " ) );
    }

    return ts;
}


/// The role choices list "can edit", "can comment", "can view", in that order.
static wxString roleFromChoice( wxChoice* aChoice )
{
    switch( aChoice->GetSelection() )
    {
    case 1:  return wxS( "commenter" );
    case 2:  return wxS( "viewer" );
    default: return wxS( "editor" );
    }
}


static int choiceFromRole( const wxString& aRole )
{
    if( aRole == wxS( "commenter" ) )
        return 1;

    if( aRole == wxS( "viewer" ) )
        return 2;

    return 0;
}


wxString DIALOG_SHARE_PROJECT::RoleLabel( const wxString& aRole )
{
    if( aRole == wxS( "owner" ) )
        return _( "owner" );

    if( aRole == wxS( "editor" ) )
        return _( "can edit" );

    if( aRole == wxS( "commenter" ) )
        return _( "can comment" );

    if( aRole == wxS( "viewer" ) )
        return _( "can view" );

    return aRole;
}


/// Identifies a "People with Access" row across a refresh.
static wxString memberKey( const nlohmann::json& aRow )
{
    if( jsonBool( aRow, "isOwner" ) )
        return wxS( "owner" );

    if( jsonBool( aRow, "pending" ) )
        return wxString::Format( wxS( "invite:%lld" ), jsonInt( aRow, "inviteId", -1LL ) );

    return wxString::Format( wxS( "user:%lld" ), jsonInt( aRow, "userId", -1LL ) );
}


static bool copyToClipboard( const wxString& aText )
{
    if( !wxTheClipboard->Open() )
        return false;

    wxTheClipboard->SetData( new wxTextDataObject( aText ) );
    wxTheClipboard->Close();

    return true;
}


DIALOG_SHARE_PROJECT::DIALOG_SHARE_PROJECT( wxWindow* aParent, const wxString& aProjectId,
                                            const wxString& aProjectName, bool aCanManage,
                                            bool aPublic ) :
        DIALOG_SHIM( aParent, wxID_ANY,
                     wxString::Format( _( "Share '%s'" ), aProjectName ), wxDefaultPosition,
                     wxSize( 620, 760 ), wxDEFAULT_DIALOG_STYLE | wxRESIZE_BORDER ),
        m_projectId( aProjectId ),
        m_searchTimer( this ),
        m_alive( std::make_shared<bool>( true ) ),
        m_searchGeneration( std::make_shared<std::atomic<int>>( 0 ) ),
        m_canManage( aCanManage ),
        m_public( aPublic ),
        m_projectChanged( false ),
        m_suppressSearch( false )
{
    m_mainSizer = new wxBoxSizer( wxVERTICAL );

    wxArrayString roles;
    roles.Add( _( "can edit" ) );
    roles.Add( _( "can comment" ) );
    roles.Add( _( "can view" ) );

    // -- Read-only note (members who are not the owner) ----------------------
    m_readOnlyNote = new wxStaticText( this, wxID_ANY,
                                       _( "Only the project owner can change who has access." ) );

    m_mainSizer->Add( m_readOnlyNote, 0, wxEXPAND | wxLEFT | wxRIGHT | wxTOP, 10 );

    // -- Share link ---------------------------------------------------------
    m_linkBox = new wxStaticBoxSizer( wxVERTICAL, this, _( "Share Links" ) );

    wxBoxSizer* linkRow = new wxBoxSizer( wxHORIZONTAL );

    m_linkRole = new wxChoice( m_linkBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                               wxDefaultSize, roles );
    m_linkRole->SetSelection( 0 );

    // In the order of LINK_EXPIRY_DAYS.
    wxArrayString expiries;
    expiries.Add( _( "never expires" ) );
    expiries.Add( _( "expires in 1 day" ) );
    expiries.Add( _( "expires in 7 days" ) );
    expiries.Add( _( "expires in 30 days" ) );

    m_linkExpiry = new wxChoice( m_linkBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                                 wxDefaultSize, expiries );
    m_linkExpiry->SetSelection( 0 );
    m_linkExpiry->SetToolTip( _( "How long a new link can be used to join.  People who "
                                 "joined with it keep their access after it expires." ) );

    m_createLinkButton = new wxButton( m_linkBox->GetStaticBox(), wxID_ANY,
                                       _( "Create && Copy Link" ) );

    linkRow->Add( new wxStaticText( m_linkBox->GetStaticBox(), wxID_ANY,
                                    _( "Anyone with the link" ) ),
                  0, wxALIGN_CENTER_VERTICAL | wxRIGHT, 5 );
    linkRow->Add( m_linkRole, 0, wxRIGHT, 5 );
    linkRow->Add( m_linkExpiry, 0, wxRIGHT, 10 );
    linkRow->Add( m_createLinkButton, 0 );

    m_links = new wxDataViewListCtrl( m_linkBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                                      wxSize( -1, 90 ), wxDV_ROW_LINES | wxDV_SINGLE );
    m_links->AppendTextColumn( _( "Link" ), wxDATAVIEW_CELL_INERT, 220 )->SetMinWidth( 160 );
    m_links->AppendTextColumn( _( "Role" ), wxDATAVIEW_CELL_INERT, 90 )->SetMinWidth( 90 );
    m_links->AppendTextColumn( _( "Created" ), wxDATAVIEW_CELL_INERT, 125 )->SetMinWidth( 120 );
    m_links->AppendTextColumn( _( "Expires" ), wxDATAVIEW_CELL_INERT, 125 )->SetMinWidth( 120 );

    wxBoxSizer* linkButtons = new wxBoxSizer( wxHORIZONTAL );

    m_copyLinkButton = new wxButton( m_linkBox->GetStaticBox(), wxID_ANY, _( "Copy Link" ) );
    m_revokeLinkButton = new wxButton( m_linkBox->GetStaticBox(), wxID_ANY, _( "Revoke Link" ) );

    linkButtons->Add( m_copyLinkButton, 0, wxRIGHT, 5 );
    linkButtons->Add( m_revokeLinkButton, 0 );

    m_linkBox->Add( linkRow, 0, wxEXPAND | wxALL, 5 );
    m_linkBox->Add( m_links, 0, wxEXPAND | wxALL, 5 );
    m_linkBox->Add( linkButtons, 0, wxALL, 5 );

    m_mainSizer->Add( m_linkBox, 0, wxEXPAND | wxALL, 10 );

    // -- Public listing -----------------------------------------------------
    m_publicCheck = new wxCheckBox( this, wxID_ANY, _( "Listed publicly in Explore" ) );
    m_publicCheck->SetValue( m_public );
    m_publicCheck->SetToolTip( _( "Show the project in the server's public gallery, where "
                                  "anyone can view it.  The people below keep their roles." ) );

    m_mainSizer->Add( m_publicCheck, 0, wxLEFT | wxRIGHT | wxBOTTOM, 10 );

    // -- Invite -------------------------------------------------------------
    m_inviteBox = new wxStaticBoxSizer( wxVERTICAL, this, _( "Invite People" ) );

    wxBoxSizer* inviteRow = new wxBoxSizer( wxHORIZONTAL );

    m_inviteText = new wxTextCtrl( m_inviteBox->GetStaticBox(), wxID_ANY, wxEmptyString,
                                   wxDefaultPosition, wxDefaultSize, wxTE_PROCESS_ENTER );
    m_inviteText->SetHint( _( "GitHub username or email" ) );

    m_inviteRole = new wxChoice( m_inviteBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                                 wxDefaultSize, roles );
    m_inviteRole->SetSelection( 0 );

    m_inviteButton = new wxButton( m_inviteBox->GetStaticBox(), wxID_ANY, _( "Invite" ) );

    inviteRow->Add( m_inviteText, 1, wxRIGHT, 5 );
    inviteRow->Add( m_inviteRole, 0, wxRIGHT, 5 );
    inviteRow->Add( m_inviteButton, 0 );

    m_results = new wxListBox( m_inviteBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                               wxSize( -1, 90 ) );

    m_inviteStatus = new wxStaticText( m_inviteBox->GetStaticBox(), wxID_ANY, wxEmptyString,
                                       wxDefaultPosition, wxDefaultSize,
                                       wxST_NO_AUTORESIZE | wxST_ELLIPSIZE_END );

    m_inviteBox->Add( inviteRow, 0, wxEXPAND | wxALL, 5 );
    m_inviteBox->Add( m_results, 0, wxEXPAND | wxALL, 5 );
    m_inviteBox->Add( m_inviteStatus, 0, wxEXPAND | wxLEFT | wxRIGHT | wxBOTTOM, 5 );

    m_mainSizer->Add( m_inviteBox, 0, wxEXPAND | wxLEFT | wxRIGHT, 10 );

    // -- Members ------------------------------------------------------------
    wxStaticBoxSizer* memberBox =
            new wxStaticBoxSizer( wxVERTICAL, this, _( "People with Access" ) );

    m_members = new wxDataViewListCtrl( memberBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                                        wxSize( -1, 150 ), wxDV_ROW_LINES | wxDV_SINGLE );
    m_members->AppendTextColumn( _( "Person" ), wxDATAVIEW_CELL_INERT, 240 )
            ->SetMinWidth( 240 );
    m_members->AppendTextColumn( _( "Role" ), wxDATAVIEW_CELL_INERT, 90 )->SetMinWidth( 90 );
    m_members->AppendTextColumn( _( "Status" ), wxDATAVIEW_CELL_INERT, 120 )->SetMinWidth( 120 );

    wxBoxSizer* memberRow = new wxBoxSizer( wxHORIZONTAL );

    m_memberRoleLabel = new wxStaticText( memberBox->GetStaticBox(), wxID_ANY,
                                          _( "Selected person" ) );
    m_memberRole = new wxChoice( memberBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                                 wxDefaultSize, roles );
    m_memberRole->SetSelection( 0 );

    m_removeButton = new wxButton( memberBox->GetStaticBox(), wxID_ANY, _( "Remove Access" ) );
    m_makeOwnerButton = new wxButton( memberBox->GetStaticBox(), wxID_ANY,
                                      _( "Make Owner..." ) );
    m_makeOwnerButton->SetToolTip( _( "Hand the project over to the selected person.  You "
                                      "stay on with edit access." ) );

    memberRow->Add( m_memberRoleLabel, 0, wxALIGN_CENTER_VERTICAL | wxRIGHT, 5 );
    memberRow->Add( m_memberRole, 0, wxRIGHT, 10 );
    memberRow->Add( m_removeButton, 0, wxRIGHT, 5 );
    memberRow->Add( m_makeOwnerButton, 0 );

    memberBox->Add( m_members, 1, wxEXPAND | wxALL, 5 );
    memberBox->Add( memberRow, 0, wxALL, 5 );

    m_mainSizer->Add( memberBox, 1, wxEXPAND | wxALL, 10 );

    // -- Status line --------------------------------------------------------
    m_statusLabel = new wxStaticText( this, wxID_ANY, wxEmptyString, wxDefaultPosition,
                                      wxDefaultSize, wxST_NO_AUTORESIZE | wxST_ELLIPSIZE_END );

    m_mainSizer->Add( m_statusLabel, 0, wxEXPAND | wxLEFT | wxRIGHT, 10 );

    m_mainSizer->Add( CreateStdDialogButtonSizer( wxCLOSE ), 0, wxEXPAND | wxALL, 5 );

    SetSizer( m_mainSizer );

    m_createLinkButton->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onCreateLink, this );
    m_copyLinkButton->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onCopyLink, this );
    m_revokeLinkButton->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onRevokeLink, this );
    m_links->Bind( wxEVT_DATAVIEW_SELECTION_CHANGED, &DIALOG_SHARE_PROJECT::onSelectionChanged,
                   this );
    m_inviteText->Bind( wxEVT_TEXT, &DIALOG_SHARE_PROJECT::onInviteText, this );
    m_inviteText->Bind( wxEVT_TEXT_ENTER, &DIALOG_SHARE_PROJECT::onInvite, this );
    m_results->Bind( wxEVT_LISTBOX, &DIALOG_SHARE_PROJECT::onResultSelected, this );
    m_inviteButton->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onInvite, this );
    m_members->Bind( wxEVT_DATAVIEW_SELECTION_CHANGED, &DIALOG_SHARE_PROJECT::onSelectionChanged,
                     this );
    m_memberRole->Bind( wxEVT_CHOICE, &DIALOG_SHARE_PROJECT::onMemberRole, this );
    m_removeButton->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onRemove, this );
    m_makeOwnerButton->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onMakeOwner, this );
    m_publicCheck->Bind( wxEVT_CHECKBOX, &DIALOG_SHARE_PROJECT::onPublic, this );
    Bind( wxEVT_TIMER, &DIALOG_SHARE_PROJECT::onSearchTimer, this );

    applyManageMode();
    updateControls();

    finishDialogSettings();

    refreshMembers();
}


DIALOG_SHARE_PROJECT::~DIALOG_SHARE_PROJECT()
{
    if( m_alive )
        *m_alive = false;

    // Searches still waiting for the worker have nobody to answer to.
    ++( *m_searchGeneration );
}


void DIALOG_SHARE_PROJECT::applyManageMode()
{
    m_readOnlyNote->Show( !m_canManage );

    m_mainSizer->Show( m_linkBox, m_canManage, true );
    m_mainSizer->Show( m_inviteBox, m_canManage, true );

    m_publicCheck->Show( m_canManage );
    m_memberRoleLabel->Show( m_canManage );
    m_memberRole->Show( m_canManage );
    m_removeButton->Show( m_canManage );
    m_makeOwnerButton->Show( m_canManage );

    Layout();
}


void DIALOG_SHARE_PROJECT::updateControls()
{
    bool idle = m_busy == 0;

    const nlohmann::json* member = selectedMember();
    const nlohmann::json* link = selectedLink();

    // The owner row is there to be seen, not edited.
    bool editable = m_canManage && member && !jsonBool( *member, "isOwner" );

    // The role choice is not touched here: see syncMemberRoleChoice().
    m_memberRole->Enable( idle && editable );
    m_removeButton->Enable( idle && editable );

    // Only someone who already has access (not merely an invitation) can take over.
    m_makeOwnerButton->Enable( idle && editable && !jsonBool( *member, "pending" ) );

    m_publicCheck->Enable( idle && m_canManage );

    m_createLinkButton->Enable( idle && m_canManage );
    m_copyLinkButton->Enable( link != nullptr );
    m_revokeLinkButton->Enable( idle && m_canManage && link );

    m_inviteButton->Enable( idle && m_canManage );
}


void DIALOG_SHARE_PROJECT::syncMemberRoleChoice()
{
    const nlohmann::json* member = selectedMember();

    if( !member || jsonBool( *member, "isOwner" ) )
        return;

    int selection = choiceFromRole( jsonStr( *member, "role" ) );

    // Only on a real difference: setting it again would disturb a choice the user has
    // open, or one that shows a change still on its way to the server.
    if( m_memberRole->GetSelection() != selection )
        m_memberRole->SetSelection( selection );
}


void DIALOG_SHARE_PROJECT::showFailure( const wxString& aWhat, const wxString& aTitle,
                                        const COLLAB_REST::ERROR_INFO& aError )
{
    wxMessageBox( aWhat + wxS( "\n\n" ) + COLLAB_REST::DescribeError( aError ), aTitle,
                  wxOK | wxICON_ERROR, this );
}


void DIALOG_SHARE_PROJECT::setStatus( const wxString& aStatus )
{
    m_statusText = aStatus;
    updateStatus();
}


void DIALOG_SHARE_PROJECT::updateStatus()
{
    wxString text = m_statusText;

    if( m_busy > 0 )
        text = m_busyText;
    else if( m_refreshing > 0 )
        text = _( "Loading who has access..." );

    // As text: names and server messages may hold an '&', which is no mnemonic here.
    if( m_statusLabel->GetLabelText() != text )
        m_statusLabel->SetLabelText( text );
}


void DIALOG_SHARE_PROJECT::beginBusy( const wxString& aStatus )
{
    m_busy++;
    m_busyText = aStatus;

    updateStatus();
    updateControls();
}


void DIALOG_SHARE_PROJECT::endBusy()
{
    if( m_busy > 0 )
        m_busy--;

    updateStatus();
    updateControls();
}


void DIALOG_SHARE_PROJECT::runAsync( const wxString& aStatus, ASYNC_WORK aWork, ASYNC_DONE aDone )
{
    wxString server = COLLAB_SESSION::ServerUrl();

    beginBusy( aStatus );

    // Off the UI thread: a slow server must not freeze the sheet.
    std::shared_ptr<bool> alive = m_alive;
    std::string           serverStd = server.ToStdString( wxConvUTF8 );
    std::string           tokenStd = COLLAB_AUTH::StoredToken( server ).ToStdString( wxConvUTF8 );

    // Written by the worker, read by the completion: never by both at once.
    std::shared_ptr<COLLAB_REST::ERROR_INFO> error = std::make_shared<COLLAB_REST::ERROR_INFO>();

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, serverStd, tokenStd, error, aWork, aDone]()
            {
                // The completion must be queued whatever happens, or the sheet
                // would stay busy for good: the worker swallows exceptions.
                bool ok = false;

                try
                {
                    ok = aWork( wxString::FromUTF8( serverStd ), wxString::FromUTF8( tokenStd ),
                                *error );
                }
                catch( ... )
                {
                    ok = false;
                    error->status = -1;
                    error->message = _( "An unexpected error occurred." );
                }

                wxTheApp->CallAfter(
                        [this, alive, ok, error, aDone]()
                        {
                            if( !*alive )
                                return;

                            endBusy();
                            aDone( ok, *error );
                        } );
            } );
}


const nlohmann::json* DIALOG_SHARE_PROJECT::selectedMember() const
{
    int row = m_members->GetSelectedRow();

    if( row == wxNOT_FOUND || row < 0 || row >= (int) m_memberRows.size() )
        return nullptr;

    return &m_memberRows[ row ];
}


const nlohmann::json* DIALOG_SHARE_PROJECT::selectedLink() const
{
    int row = m_links->GetSelectedRow();

    if( row == wxNOT_FOUND || row < 0 || row >= (int) m_linkRows.size() )
        return nullptr;

    return &m_linkRows[ row ];
}


void DIALOG_SHARE_PROJECT::onSelectionChanged( wxDataViewEvent& aEvent )
{
    syncMemberRoleChoice();
    updateControls();
}


void DIALOG_SHARE_PROJECT::onCreateLink( wxCommandEvent& aEvent )
{
    if( m_busy > 0 || !m_canManage )
        return;

    std::shared_ptr<nlohmann::json> linkOut = std::make_shared<nlohmann::json>();

    std::string projectIdStd = m_projectId.ToStdString( wxConvUTF8 );
    std::string roleStd = roleFromChoice( m_linkRole ).ToStdString( wxConvUTF8 );

    int expiry = m_linkExpiry->GetSelection();
    int expiresInDays = expiry > 0 && expiry < (int) std::size( LINK_EXPIRY_DAYS )
                                ? LINK_EXPIRY_DAYS[ expiry ]
                                : 0;

    setStatus( wxEmptyString );

    runAsync( _( "Creating a share link..." ),
            [projectIdStd, roleStd, expiresInDays, linkOut]( const wxString& aServer,
                                                            const wxString& aToken,
                                                            COLLAB_REST::ERROR_INFO& aError )
            {
                std::optional<nlohmann::json> link =
                        COLLAB_REST::CreateShareLink( aServer, aToken,
                                                      wxString::FromUTF8( projectIdStd ),
                                                      wxString::FromUTF8( roleStd ),
                                                      expiresInDays, &aError );

                if( !link )
                    return false;

                *linkOut = *link;
                return true;
            },
            [this, linkOut]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( _( "Creating the share link failed." ), _( "Share Link" ),
                                 aError );
                    return;
                }

                wxString url = jsonStr( *linkOut, "url" );

                // Show it straight away; the refresh below replaces the row with
                // the server's own listing when that is available.
                m_linkRows.insert( m_linkRows.begin(), *linkOut );
                populateLinks();

                if( !m_linkRows.empty() )
                    m_links->SelectRow( 0 );

                if( copyToClipboard( url ) )
                    setStatus( _( "Link created and copied to the clipboard." ) );
                else
                    setStatus( _( "Link created." ) );

                refreshMembers();
            } );
}


void DIALOG_SHARE_PROJECT::onCopyLink( wxCommandEvent& aEvent )
{
    const nlohmann::json* link = selectedLink();

    if( !link )
        return;

    if( copyToClipboard( jsonStr( *link, "url" ) ) )
        setStatus( _( "Link copied to the clipboard." ) );
    else
        setStatus( _( "The clipboard is not available." ) );
}


void DIALOG_SHARE_PROJECT::onRevokeLink( wxCommandEvent& aEvent )
{
    const nlohmann::json* link = selectedLink();

    if( !link || m_busy > 0 || !m_canManage )
        return;

    wxString linkToken = jsonStr( *link, "token" );

    if( linkToken.IsEmpty() )
        return;

    if( wxMessageBox( _( "Revoke this share link?\n\nThe link stops working.  People who "
                         "already joined with it keep their access; remove them under "
                         "People with Access." ),
                      _( "Revoke Share Link" ), wxYES_NO | wxNO_DEFAULT | wxICON_QUESTION, this )
        != wxYES )
    {
        return;
    }

    std::string linkTokenStd = linkToken.ToStdString( wxConvUTF8 );

    setStatus( wxEmptyString );

    runAsync( _( "Revoking the share link..." ),
            [linkTokenStd]( const wxString& aServer, const wxString& aToken,
                            COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::RevokeShareLink( aServer, aToken,
                                                     wxString::FromUTF8( linkTokenStd ), &aError );
            },
            [this, linkTokenStd]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                {
                    showFailure( _( "Revoking the share link failed." ), _( "Revoke Share Link" ),
                                 aError );
                    return;
                }

                wxString revoked = wxString::FromUTF8( linkTokenStd );

                for( size_t i = 0; i < m_linkRows.size(); i++ )
                {
                    if( jsonStr( m_linkRows[ i ], "token" ) == revoked )
                    {
                        m_linkRows.erase( m_linkRows.begin() + i );
                        break;
                    }
                }

                populateLinks();
                setStatus( _( "Link revoked." ) );

                refreshMembers();
            } );
}


void DIALOG_SHARE_PROJECT::onInviteText( wxCommandEvent& aEvent )
{
    // Whatever is still being searched for was asked about text that is gone now.
    ++( *m_searchGeneration );

    if( m_suppressSearch )
        return;

    m_searchTimer.StartOnce( SEARCH_DELAY_MS );
}


void DIALOG_SHARE_PROJECT::onSearchTimer( wxTimerEvent& aEvent )
{
    // A generation counter drops results that arrive after a newer query.  Taken
    // before anything can return: no search for this text is a newer query as well.
    int generation = ++( *m_searchGeneration );

    wxString query = m_inviteText->GetValue().Trim( true ).Trim( false );

    // "@name" is how people write GitHub handles; search for the name.
    if( query.StartsWith( wxS( "@" ) ) )
        query = query.Mid( 1 );

    m_results->Clear();
    m_resultRows.clear();

    // An email is invited directly, not searched.
    if( !m_canManage || query.length() < 2 || query.Contains( wxS( "@" ) ) )
        return;

    wxString server = COLLAB_SESSION::ServerUrl();

    // Search off the UI thread: typing must stay smooth even when the server
    // (or the GitHub proxy behind it) is slow.
    std::shared_ptr<bool> alive = m_alive;
    std::string serverStd = server.ToStdString( wxConvUTF8 );
    std::string tokenStd = COLLAB_AUTH::StoredToken( server ).ToStdString( wxConvUTF8 );
    std::string queryStd = query.ToStdString( wxConvUTF8 );

    // The worker runs its jobs one after the other: a search the user has typed past
    // must not hold up the next one, or an Invite, for a whole request.
    std::shared_ptr<std::atomic<int>> latest = m_searchGeneration;

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, generation, latest, serverStd, tokenStd, queryStd]()
            {
                if( generation != latest->load() )
                    return;

                std::optional<nlohmann::json> found =
                        COLLAB_REST::SearchUsers( wxString::FromUTF8( serverStd ),
                                                  wxString::FromUTF8( tokenStd ),
                                                  wxString::FromUTF8( queryStd ) );

                nlohmann::json users = found && found->contains( "users" )
                                               ? ( *found )[ "users" ]
                                               : nlohmann::json::array();

                wxTheApp->CallAfter(
                        [this, alive, generation, users]()
                        {
                            if( !*alive || generation != m_searchGeneration->load() )
                                return;

                            showSearchResults( users );
                        } );
            } );
}


void DIALOG_SHARE_PROJECT::showSearchResults( const nlohmann::json& aUsers )
{
    m_results->Clear();
    m_resultRows.clear();

    if( !aUsers.is_array() )
        return;

    for( const nlohmann::json& user : aUsers )
    {
        wxString login = jsonStr( user, "login" );
        wxString name = jsonStr( user, "name" );
        wxString source = jsonStr( user, "source" );

        if( login.IsEmpty() )
            continue;

        wxString label = login;

        if( !name.IsEmpty() )
            label += wxS( "  (" ) + name + wxS( ")" );

        if( source == wxS( "github" ) )
            label += _( "  — GitHub" );

        m_results->Append( label );
        m_resultRows.push_back( user );
    }
}


void DIALOG_SHARE_PROJECT::onResultSelected( wxCommandEvent& aEvent )
{
    int row = m_results->GetSelection();

    if( row == wxNOT_FOUND || row >= (int) m_resultRows.size() )
        return;

    m_suppressSearch = true;
    m_inviteText->SetValue( jsonStr( m_resultRows[ row ], "login" ) );
    m_suppressSearch = false;
}


void DIALOG_SHARE_PROJECT::onInvite( wxCommandEvent& aEvent )
{
    if( m_busy > 0 || !m_canManage )
        return;

    wxString who = m_inviteText->GetValue().Trim( true ).Trim( false );

    // "@octocat" is a GitHub handle, not an email.
    if( who.StartsWith( wxS( "@" ) ) )
        who = who.Mid( 1 ).Trim( false );

    if( who.IsEmpty() )
        return;

    wxString login, email;

    if( who.Contains( wxS( "@" ) ) )
        email = who;
    else
        login = who;

    wxString role = roleFromChoice( m_inviteRole );

    std::shared_ptr<nlohmann::json> resultOut = std::make_shared<nlohmann::json>();

    std::string projectIdStd = m_projectId.ToStdString( wxConvUTF8 );
    std::string whoStd = who.ToStdString( wxConvUTF8 );
    std::string loginStd = login.ToStdString( wxConvUTF8 );
    std::string emailStd = email.ToStdString( wxConvUTF8 );
    std::string roleStd = role.ToStdString( wxConvUTF8 );

    // No stale typeahead popping up under the result.
    m_searchTimer.Stop();
    ++( *m_searchGeneration );

    m_inviteStatus->SetLabel( wxEmptyString );
    setStatus( wxEmptyString );

    runAsync( wxString::Format( _( "Inviting %s..." ), who ),
            [projectIdStd, loginStd, emailStd, roleStd, resultOut](
                    const wxString& aServer, const wxString& aToken,
                    COLLAB_REST::ERROR_INFO& aError )
            {
                std::optional<nlohmann::json> result =
                        COLLAB_REST::Invite( aServer, aToken, wxString::FromUTF8( projectIdStd ),
                                             wxString::FromUTF8( loginStd ),
                                             wxString::FromUTF8( emailStd ),
                                             wxString::FromUTF8( roleStd ), &aError );

                if( !result )
                    return false;

                *resultOut = *result;
                return true;
            },
            [this, whoStd, roleStd, resultOut]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                wxString invited = wxString::FromUTF8( whoStd );

                if( !aOk )
                {
                    // The server's reason: the person owns the project, the sign-in ran
                    // out, the connection dropped...  An unknown name is not an error at
                    // all; it becomes a pending invitation.
                    wxString reason = wxString::Format( _( "%s could not be invited.  %s" ),
                                                        invited,
                                                        COLLAB_REST::DescribeError( aError ) );

                    m_inviteStatus->SetLabelText( reason );
                    m_inviteStatus->SetToolTip( reason );
                    return;
                }

                m_inviteStatus->UnsetToolTip();

                if( jsonStr( *resultOut, "status" ) == wxS( "pending" ) )
                {
                    m_inviteStatus->SetLabelText( wxString::Format( _( "%s will get access when "
                                                                   "they sign in" ),
                                                                invited ) );
                }
                else
                {
                    m_inviteStatus->SetLabelText( wxString::Format(
                            _( "Invited %s as %s" ), invited,
                            roleStd == "viewer"      ? _( "viewer" )
                            : roleStd == "commenter" ? _( "commenter" )
                                                     : _( "editor" ) ) );
                }

                m_suppressSearch = true;
                m_inviteText->Clear();
                m_suppressSearch = false;
                m_results->Clear();
                m_resultRows.clear();
                m_inviteText->SetFocus();

                refreshMembers();
            } );
}


void DIALOG_SHARE_PROJECT::refreshMembers()
{
    wxString server = COLLAB_SESSION::ServerUrl();

    // Anything still in flight from an earlier refresh is stale now.
    int generation = ++m_refreshGeneration;

    // Not a busy state: the listing only reads, and waiting for it must not
    // swallow the next invite typed while it loads.
    m_refreshing++;
    updateStatus();

    std::shared_ptr<bool> alive = m_alive;
    std::string           serverStd = server.ToStdString( wxConvUTF8 );
    std::string           tokenStd = COLLAB_AUTH::StoredToken( server ).ToStdString( wxConvUTF8 );
    std::string           projectIdStd = m_projectId.ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, generation, serverStd, tokenStd, projectIdStd]()
            {
                nlohmann::json membersJson = nlohmann::json::object();
                nlohmann::json linksJson = nlohmann::json::object();
                bool           membersOk = false;
                bool           linksOk = false;

                // The completion below must be queued whatever happens: the
                // worker swallows exceptions and the count would never drop.
                try
                {
                    wxString serverUrl = wxString::FromUTF8( serverStd );
                    wxString token = wxString::FromUTF8( tokenStd );
                    wxString projectId = wxString::FromUTF8( projectIdStd );

                    std::optional<nlohmann::json> members =
                            COLLAB_REST::ListMembers( serverUrl, token, projectId );

                    // A server that predates canManage only answers its owner.
                    bool canManage = members.has_value()
                                     && ( !members->is_object()
                                          || !members->contains( "canManage" )
                                          || jsonBool( *members, "canManage" ) );

                    std::optional<nlohmann::json> links;

                    // Share links are the owner's business; don't ask for a refusal.
                    if( canManage )
                        links = COLLAB_REST::ListShareLinks( serverUrl, token, projectId );

                    if( members )
                    {
                        membersJson = *members;
                        membersOk = true;
                    }

                    if( links )
                    {
                        linksJson = *links;
                        linksOk = true;
                    }
                }
                catch( ... )
                {
                    membersJson = nlohmann::json::object();
                    membersOk = false;
                    linksOk = false;
                }

                wxTheApp->CallAfter(
                        [this, alive, generation, membersJson, membersOk, linksJson, linksOk]()
                        {
                            if( !*alive )
                                return;

                            if( m_refreshing > 0 )
                                m_refreshing--;

                            updateStatus();

                            if( generation != m_refreshGeneration )
                                return;

                            populate( membersJson, membersOk, linksJson, linksOk );
                        } );
            } );
}


void DIALOG_SHARE_PROJECT::populate( const nlohmann::json& aMembers, bool aMembersOk,
                                     const nlohmann::json& aLinks, bool aLinksOk )
{
    const nlohmann::json* selected = selectedMember();
    wxString              keepKey = selected ? memberKey( *selected ) : wxString();

    m_members->DeleteAllItems();
    m_memberRows.clear();

    if( !aMembersOk )
    {
        setStatus( _( "The list of people with access could not be loaded." ) );
        updateControls();
        return;
    }

    // The server has the last word on who may manage access.
    bool canManage = !aMembers.contains( "canManage" ) || jsonBool( aMembers, "canManage" );

    if( canManage != m_canManage )
    {
        m_canManage = canManage;
        applyManageMode();
    }

    long long ownerId = jsonInt( aMembers, "ownerId", -1LL );
    bool      ownerShown = false;

    // The owner leads the list.
    if( aMembers.contains( "owner" ) && aMembers[ "owner" ].is_object() )
    {
        const nlohmann::json& owner = aMembers[ "owner" ];

        wxVector<wxVariant> row;
        row.push_back( wxVariant( jsonStr( owner, "login" ) ) );
        row.push_back( wxVariant( _( "owner" ) ) );
        row.push_back( wxVariant( wxString() ) );

        m_members->AppendItem( row );

        nlohmann::json ownerRow = owner;
        ownerRow[ "isOwner" ] = true;
        m_memberRows.push_back( ownerRow );

        ownerShown = true;
    }

    for( const nlohmann::json& member : jsonArray( aMembers, "members" ) )
    {
        if( !member.is_object() )
            continue;

        // Listed above already.
        if( ownerShown && ownerId >= 0 && jsonInt( member, "userId", -1LL ) == ownerId )
            continue;

        wxVector<wxVariant> row;
        row.push_back( wxVariant( jsonStr( member, "login" ) ) );
        row.push_back( wxVariant( RoleLabel( jsonStr( member, "role" ) ) ) );
        row.push_back( wxVariant( _( "member" ) ) );

        m_members->AppendItem( row );
        m_memberRows.push_back( member );
    }

    for( const nlohmann::json& invite : jsonArray( aMembers, "pending" ) )
    {
        if( !invite.is_object() )
            continue;

        wxString who = jsonStr( invite, "login" );

        if( who.IsEmpty() )
            who = jsonStr( invite, "email" );

        wxVector<wxVariant> row;
        row.push_back( wxVariant( who ) );
        row.push_back( wxVariant( RoleLabel( jsonStr( invite, "role" ) ) ) );
        row.push_back( wxVariant( _( "invited" ) ) );

        m_members->AppendItem( row );

        nlohmann::json pendingRow = invite;
        pendingRow[ "pending" ] = true;
        m_memberRows.push_back( pendingRow );
    }

    // Keep the same person selected, e.g. after changing their role.
    if( !keepKey.IsEmpty() )
    {
        for( size_t i = 0; i < m_memberRows.size(); i++ )
        {
            if( memberKey( m_memberRows[ i ] ) == keepKey )
            {
                m_members->SelectRow( (unsigned) i );
                break;
            }
        }
    }

    // Without a listing (an older server) the links created in this sheet stay.
    if( aLinksOk )
    {
        m_linkRows.clear();

        for( const nlohmann::json& link : jsonArray( aLinks, "links" ) )
        {
            if( link.is_object() )
                m_linkRows.push_back( link );
        }

        populateLinks();
    }

    syncMemberRoleChoice();
    updateControls();
}


void DIALOG_SHARE_PROJECT::populateLinks()
{
    const nlohmann::json* selected = selectedLink();
    wxString              keepToken = selected ? jsonStr( *selected, "token" ) : wxString();

    m_links->DeleteAllItems();

    for( size_t i = 0; i < m_linkRows.size(); i++ )
    {
        const nlohmann::json& link = m_linkRows[ i ];

        wxVector<wxVariant> row;
        row.push_back( wxVariant( jsonStr( link, "url" ) ) );
        row.push_back( wxVariant( RoleLabel( jsonStr( link, "role" ) ) ) );
        row.push_back( wxVariant( prettyTimestamp( jsonStr( link, "createdAt" ) ) ) );

        // A link just created here is shown before the server has listed it, and so
        // before its dates are known.
        if( !link.contains( "createdAt" ) )
            row.push_back( wxVariant( wxString() ) );
        else if( jsonStr( link, "expiresAt" ).IsEmpty() )
            row.push_back( wxVariant( _( "never" ) ) );
        else
            row.push_back( wxVariant( prettyTimestamp( jsonStr( link, "expiresAt" ) ) ) );

        m_links->AppendItem( row );

        if( !keepToken.IsEmpty() && jsonStr( link, "token" ) == keepToken )
            m_links->SelectRow( (unsigned) i );
    }

    updateControls();
}


void DIALOG_SHARE_PROJECT::onMemberRole( wxCommandEvent& aEvent )
{
    const nlohmann::json* member = selectedMember();

    if( !member || m_busy > 0 || !m_canManage || jsonBool( *member, "isOwner" ) )
    {
        // Put the choice back to what the row says.
        syncMemberRoleChoice();
        return;
    }

    wxString newRole = roleFromChoice( m_memberRole );

    if( newRole == jsonStr( *member, "role" ) )
        return;

    bool      pending = jsonBool( *member, "pending" );
    long long id = pending ? jsonInt( *member, "inviteId", -1LL )
                           : jsonInt( *member, "userId", -1LL );
    wxString  who = jsonStr( *member, "login" );

    if( who.IsEmpty() )
        who = jsonStr( *member, "email" );

    std::string projectIdStd = m_projectId.ToStdString( wxConvUTF8 );
    std::string newRoleStd = newRole.ToStdString( wxConvUTF8 );
    std::string whoStd = who.ToStdString( wxConvUTF8 );

    // Show the new role at once, in the row as well as in the choice: the list is the
    // record the choice is kept in step with, and a choice that jumped back while the
    // change is on its way would look like a refusal.  A listing still in flight
    // predates the change and is dropped; the one fetched afterwards has the last
    // word, and puts the old role back if the change did not take.
    int row = m_members->GetSelectedRow();

    m_refreshGeneration++;
    m_memberRows[ row ][ "role" ] = newRoleStd;
    m_members->SetTextValue( RoleLabel( newRole ), row, 1 );

    setStatus( wxEmptyString );

    runAsync( wxString::Format( _( "Changing the role of %s..." ), who ),
            [projectIdStd, newRoleStd, pending, id]( const wxString& aServer,
                                                     const wxString& aToken,
                                                     COLLAB_REST::ERROR_INFO& aError )
            {
                if( pending )
                {
                    return COLLAB_REST::SetInviteRole( aServer, aToken,
                                                       wxString::FromUTF8( projectIdStd ), id,
                                                       wxString::FromUTF8( newRoleStd ),
                                                       &aError );
                }

                return COLLAB_REST::SetMemberRole( aServer, aToken,
                                                   wxString::FromUTF8( projectIdStd ), id,
                                                   wxString::FromUTF8( newRoleStd ), &aError );
            },
            [this, whoStd, newRoleStd]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( aOk )
                {
                    setStatus( wxString::Format( _( "Access for %s changed to '%s'." ),
                                                 wxString::FromUTF8( whoStd ),
                                                 RoleLabel( wxString::FromUTF8( newRoleStd ) ) ) );
                }
                else
                {
                    showFailure( _( "Changing the role failed." ), _( "Change Role" ), aError );
                }

                // Also puts the choice back when the change did not take.
                refreshMembers();
            } );
}


void DIALOG_SHARE_PROJECT::onRemove( wxCommandEvent& aEvent )
{
    const nlohmann::json* member = selectedMember();

    if( !member || m_busy > 0 || !m_canManage || jsonBool( *member, "isOwner" ) )
        return;

    bool      pending = jsonBool( *member, "pending" );
    long long id = pending ? jsonInt( *member, "inviteId", -1LL )
                           : jsonInt( *member, "userId", -1LL );

    std::string projectIdStd = m_projectId.ToStdString( wxConvUTF8 );

    setStatus( wxEmptyString );

    runAsync( _( "Removing access..." ),
            [projectIdStd, pending, id]( const wxString& aServer, const wxString& aToken,
                                         COLLAB_REST::ERROR_INFO& aError )
            {
                if( pending )
                {
                    return COLLAB_REST::RevokeInvite( aServer, aToken,
                                                      wxString::FromUTF8( projectIdStd ), id,
                                                      &aError );
                }

                return COLLAB_REST::RemoveMember( aServer, aToken,
                                                  wxString::FromUTF8( projectIdStd ), id,
                                                  &aError );
            },
            [this]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( !aOk )
                    showFailure( _( "Removing access failed." ), _( "Remove Access" ), aError );

                refreshMembers();
            } );
}


void DIALOG_SHARE_PROJECT::onMakeOwner( wxCommandEvent& )
{
    const nlohmann::json* member = selectedMember();

    if( !member || m_busy > 0 || !m_canManage || jsonBool( *member, "isOwner" )
        || jsonBool( *member, "pending" ) )
    {
        return;
    }

    long long userId = jsonInt( *member, "userId", -1LL );
    wxString  who = jsonStr( *member, "login" );

    if( userId < 0 )
        return;

    if( wxMessageBox( wxString::Format( _( "Make %s the owner of this project?\n\n"
                                           "The owner decides who has access and can rename "
                                           "or delete the project.  You keep edit access, "
                                           "but only %s can give the project back to you." ),
                                        who, who ),
                      _( "Make Owner" ), wxYES_NO | wxNO_DEFAULT | wxICON_WARNING, this )
        != wxYES )
    {
        return;
    }

    std::string projectIdStd = m_projectId.ToStdString( wxConvUTF8 );
    std::string whoStd = who.ToStdString( wxConvUTF8 );

    setStatus( wxEmptyString );

    // From here on the request is on its way, and it is carried out even when the sheet
    // is closed before the answer: the caller must reload either way.
    m_projectChanged = true;

    runAsync( wxString::Format( _( "Making %s the owner..." ), who ),
            [projectIdStd, userId]( const wxString& aServer, const wxString& aToken,
                                    COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::TransferProject( aServer, aToken,
                                                     wxString::FromUTF8( projectIdStd ), userId,
                                                     &aError );
            },
            [this, whoStd]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( aOk )
                {
                    m_projectChanged = true;
                    setStatus( wxString::Format( _( "%s is now the owner of the project." ),
                                                 wxString::FromUTF8( whoStd ) ) );
                }
                else
                {
                    showFailure( _( "Changing the owner failed." ), _( "Make Owner" ), aError );
                }

                // The fresh listing says who manages access now, and turns the sheet
                // read-only once that is someone else.
                refreshMembers();
            } );
}


void DIALOG_SHARE_PROJECT::onPublic( wxCommandEvent& )
{
    bool makePublic = m_publicCheck->GetValue();

    if( makePublic == m_public )
        return;

    if( m_busy > 0 || !m_canManage
        || ( makePublic
             && wxMessageBox( _( "List this project publicly?\n\nIt will appear in the "
                                 "server's gallery and anyone can view it, signed in or "
                                 "not.  Members keep their existing roles." ),
                              _( "Make Project Public" ), wxYES_NO | wxICON_QUESTION, this )
                        != wxYES ) )
    {
        m_publicCheck->SetValue( m_public );
        return;
    }

    std::string projectIdStd = m_projectId.ToStdString( wxConvUTF8 );

    setStatus( wxEmptyString );

    // As in onMakeOwner(): sent is as good as changed for whoever reloads after us.
    m_projectChanged = true;

    runAsync( makePublic ? _( "Listing the project publicly..." )
                         : _( "Making the project private..." ),
            [projectIdStd, makePublic]( const wxString& aServer, const wxString& aToken,
                                        COLLAB_REST::ERROR_INFO& aError )
            {
                return COLLAB_REST::SetProjectPublic( aServer, aToken,
                                                      wxString::FromUTF8( projectIdStd ),
                                                      makePublic, &aError );
            },
            [this, makePublic]( bool aOk, const COLLAB_REST::ERROR_INFO& aError )
            {
                if( aOk )
                {
                    m_public = makePublic;
                    m_projectChanged = true;
                    setStatus( makePublic ? _( "The project is listed publicly now." )
                                          : _( "The project is private now." ) );
                }
                else
                {
                    showFailure( _( "Updating the project visibility failed." ),
                                 _( "Project Visibility" ), aError );
                }

                // Back to what the server has, should the change not have taken.
                m_publicCheck->SetValue( m_public );
            } );
}
