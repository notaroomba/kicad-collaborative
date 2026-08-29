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

#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>

#include <wx/button.h>
#include <wx/choice.h>
#include <wx/clipbrd.h>
#include <wx/dataview.h>
#include <wx/listbox.h>
#include <wx/msgdlg.h>
#include <wx/sizer.h>
#include <wx/statbox.h>
#include <wx/stattext.h>
#include <wx/textctrl.h>

/// Debounce for the user-search typeahead.
static constexpr int SEARCH_DELAY_MS = 350;


DIALOG_SHARE_PROJECT::DIALOG_SHARE_PROJECT( wxWindow* aParent, const wxString& aProjectId,
                                            const wxString& aProjectName ) :
        DIALOG_SHIM( aParent, wxID_ANY,
                     wxString::Format( _( "Share '%s'" ), aProjectName ), wxDefaultPosition,
                     wxSize( 560, 620 ), wxDEFAULT_DIALOG_STYLE | wxRESIZE_BORDER ),
        m_projectId( aProjectId ),
        m_searchTimer( this ),
        m_suppressSearch( false )
{
    wxBoxSizer* mainSizer = new wxBoxSizer( wxVERTICAL );

    wxArrayString roles;
    roles.Add( _( "can edit" ) );
    roles.Add( _( "can view" ) );

    // -- Share link ---------------------------------------------------------
    wxStaticBoxSizer* linkBox =
            new wxStaticBoxSizer( wxVERTICAL, this, _( "Share Link" ) );

    wxBoxSizer* linkRow = new wxBoxSizer( wxHORIZONTAL );

    m_linkRole = new wxChoice( linkBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                               wxDefaultSize, roles );
    m_linkRole->SetSelection( 0 );

    wxButton* createLink = new wxButton( linkBox->GetStaticBox(), wxID_ANY,
                                         _( "Create && Copy Link" ) );

    linkRow->Add( new wxStaticText( linkBox->GetStaticBox(), wxID_ANY,
                                    _( "Anyone with the link" ) ),
                  0, wxALIGN_CENTER_VERTICAL | wxRIGHT, 5 );
    linkRow->Add( m_linkRole, 0, wxRIGHT, 10 );
    linkRow->Add( createLink, 0 );

    m_linkText = new wxTextCtrl( linkBox->GetStaticBox(), wxID_ANY, wxEmptyString,
                                 wxDefaultPosition, wxDefaultSize, wxTE_READONLY );

    linkBox->Add( linkRow, 0, wxEXPAND | wxALL, 5 );
    linkBox->Add( m_linkText, 0, wxEXPAND | wxALL, 5 );

    mainSizer->Add( linkBox, 0, wxEXPAND | wxALL, 10 );

    // -- Invite -------------------------------------------------------------
    wxStaticBoxSizer* inviteBox =
            new wxStaticBoxSizer( wxVERTICAL, this, _( "Invite People" ) );

    wxBoxSizer* inviteRow = new wxBoxSizer( wxHORIZONTAL );

    m_inviteText = new wxTextCtrl( inviteBox->GetStaticBox(), wxID_ANY );
    m_inviteText->SetHint( _( "GitHub username or email" ) );

    m_inviteRole = new wxChoice( inviteBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                                 wxDefaultSize, roles );
    m_inviteRole->SetSelection( 0 );

    m_inviteButton = new wxButton( inviteBox->GetStaticBox(), wxID_ANY, _( "Invite" ) );

    inviteRow->Add( m_inviteText, 1, wxRIGHT, 5 );
    inviteRow->Add( m_inviteRole, 0, wxRIGHT, 5 );
    inviteRow->Add( m_inviteButton, 0 );

    m_results = new wxListBox( inviteBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                               wxSize( -1, 110 ) );

    inviteBox->Add( inviteRow, 0, wxEXPAND | wxALL, 5 );
    inviteBox->Add( m_results, 0, wxEXPAND | wxALL, 5 );

    mainSizer->Add( inviteBox, 0, wxEXPAND | wxLEFT | wxRIGHT, 10 );

    // -- Members ------------------------------------------------------------
    wxStaticBoxSizer* memberBox =
            new wxStaticBoxSizer( wxVERTICAL, this, _( "People with Access" ) );

    m_members = new wxDataViewListCtrl( memberBox->GetStaticBox(), wxID_ANY, wxDefaultPosition,
                                        wxSize( -1, 150 ), wxDV_ROW_LINES | wxDV_SINGLE );
    m_members->AppendTextColumn( _( "Person" ), wxDATAVIEW_CELL_INERT, 240 )
            ->SetMinWidth( 240 );
    m_members->AppendTextColumn( _( "Role" ), wxDATAVIEW_CELL_INERT, 90 )->SetMinWidth( 90 );
    m_members->AppendTextColumn( _( "Status" ), wxDATAVIEW_CELL_INERT, 120 )->SetMinWidth( 120 );

    m_removeButton = new wxButton( memberBox->GetStaticBox(), wxID_ANY, _( "Remove Access" ) );

    memberBox->Add( m_members, 1, wxEXPAND | wxALL, 5 );
    memberBox->Add( m_removeButton, 0, wxALL, 5 );

    mainSizer->Add( memberBox, 1, wxEXPAND | wxALL, 10 );

    mainSizer->Add( CreateStdDialogButtonSizer( wxCLOSE ), 0, wxEXPAND | wxALL, 5 );

    SetSizer( mainSizer );

    createLink->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onCreateLink, this );
    m_inviteText->Bind( wxEVT_TEXT, &DIALOG_SHARE_PROJECT::onInviteText, this );
    m_results->Bind( wxEVT_LISTBOX, &DIALOG_SHARE_PROJECT::onResultSelected, this );
    m_inviteButton->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onInvite, this );
    m_removeButton->Bind( wxEVT_BUTTON, &DIALOG_SHARE_PROJECT::onRemove, this );
    Bind( wxEVT_TIMER, &DIALOG_SHARE_PROJECT::onSearchTimer, this );

    finishDialogSettings();

    refreshMembers();
}


static wxString roleFromChoice( wxChoice* aChoice )
{
    return aChoice->GetSelection() == 1 ? wxS( "viewer" ) : wxS( "editor" );
}


void DIALOG_SHARE_PROJECT::onCreateLink( wxCommandEvent& aEvent )
{
    wxString server = COLLAB_SESSION::ServerUrl();

    std::optional<nlohmann::json> link =
            COLLAB_REST::CreateShareLink( server, COLLAB_AUTH::StoredToken( server ),
                                          m_projectId, roleFromChoice( m_linkRole ) );

    if( !link )
    {
        wxMessageBox( _( "Creating the share link failed." ), _( "Share Link" ),
                      wxOK | wxICON_ERROR, this );
        return;
    }

    wxString url = wxString::FromUTF8( link->value( "url", "" ) );

    m_linkText->SetValue( url );

    if( wxTheClipboard->Open() )
    {
        wxTheClipboard->SetData( new wxTextDataObject( url ) );
        wxTheClipboard->Close();
    }
}


void DIALOG_SHARE_PROJECT::onInviteText( wxCommandEvent& aEvent )
{
    if( m_suppressSearch )
        return;

    m_searchTimer.StartOnce( SEARCH_DELAY_MS );
}


void DIALOG_SHARE_PROJECT::onSearchTimer( wxTimerEvent& aEvent )
{
    wxString query = m_inviteText->GetValue().Trim( true ).Trim( false );

    m_results->Clear();
    m_resultRows.clear();

    // An email is invited directly, not searched.
    if( query.length() < 2 || query.Contains( wxS( "@" ) ) )
        return;

    wxString server = COLLAB_SESSION::ServerUrl();

    std::optional<nlohmann::json> found =
            COLLAB_REST::SearchUsers( server, COLLAB_AUTH::StoredToken( server ), query );

    if( !found || !found->contains( "users" ) )
        return;

    for( const nlohmann::json& user : ( *found )[ "users" ] )
    {
        wxString login = wxString::FromUTF8( user.value( "login", "" ) );
        wxString name = wxString::FromUTF8( user.value( "name", "" ) );
        wxString source = wxString::FromUTF8( user.value( "source", "" ) );

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
    m_inviteText->SetValue( wxString::FromUTF8( m_resultRows[ row ].value( "login", "" ) ) );
    m_suppressSearch = false;
}


void DIALOG_SHARE_PROJECT::onInvite( wxCommandEvent& aEvent )
{
    wxString who = m_inviteText->GetValue().Trim( true ).Trim( false );

    if( who.IsEmpty() )
        return;

    wxString login, email;

    if( who.Contains( wxS( "@" ) ) )
        email = who;
    else
        login = who;

    wxString server = COLLAB_SESSION::ServerUrl();

    std::optional<nlohmann::json> result =
            COLLAB_REST::Invite( server, COLLAB_AUTH::StoredToken( server ), m_projectId, login,
                                 email, roleFromChoice( m_inviteRole ) );

    if( !result )
    {
        wxMessageBox( _( "The invite could not be created." ), _( "Invite" ),
                      wxOK | wxICON_ERROR, this );
        return;
    }

    m_suppressSearch = true;
    m_inviteText->Clear();
    m_suppressSearch = false;
    m_results->Clear();
    m_resultRows.clear();

    refreshMembers();
}


void DIALOG_SHARE_PROJECT::refreshMembers()
{
    m_members->DeleteAllItems();
    m_memberRows.clear();

    wxString server = COLLAB_SESSION::ServerUrl();

    std::optional<nlohmann::json> members =
            COLLAB_REST::ListMembers( server, COLLAB_AUTH::StoredToken( server ), m_projectId );

    if( !members )
        return;

    for( const nlohmann::json& member : members->value( "members", nlohmann::json::array() ) )
    {
        wxVector<wxVariant> row;
        row.push_back( wxVariant( wxString::FromUTF8( member.value( "login", "" ) ) ) );
        row.push_back( wxVariant( wxString::FromUTF8( member.value( "role", "" ) ) ) );
        row.push_back( wxVariant( _( "member" ) ) );

        m_members->AppendItem( row );
        m_memberRows.push_back( member );
    }

    for( const nlohmann::json& invite : members->value( "pending", nlohmann::json::array() ) )
    {
        wxString who = wxString::FromUTF8( invite.value( "login", "" ) );

        if( who.IsEmpty() && invite.contains( "email" ) && invite[ "email" ].is_string() )
            who = wxString::FromUTF8( invite[ "email" ].get<std::string>() );

        wxVector<wxVariant> row;
        row.push_back( wxVariant( who ) );
        row.push_back( wxVariant( wxString::FromUTF8( invite.value( "role", "" ) ) ) );
        row.push_back( wxVariant( _( "invited" ) ) );

        m_members->AppendItem( row );

        nlohmann::json pendingRow = invite;
        pendingRow[ "pending" ] = true;
        m_memberRows.push_back( pendingRow );
    }
}


void DIALOG_SHARE_PROJECT::onRemove( wxCommandEvent& aEvent )
{
    int row = m_members->GetSelectedRow();

    if( row == wxNOT_FOUND || row >= (int) m_memberRows.size() )
        return;

    const nlohmann::json& member = m_memberRows[ row ];
    wxString              server = COLLAB_SESSION::ServerUrl();
    wxString              token = COLLAB_AUTH::StoredToken( server );
    bool                  ok;

    if( member.value( "pending", false ) )
        ok = COLLAB_REST::RevokeInvite( server, token, m_projectId,
                                        member.value( "inviteId", -1LL ) );
    else
        ok = COLLAB_REST::RemoveMember( server, token, m_projectId,
                                        member.value( "userId", -1LL ) );

    if( !ok )
    {
        wxMessageBox( _( "Removing access failed." ), _( "Remove Access" ),
                      wxOK | wxICON_ERROR, this );
    }

    refreshMembers();
}
