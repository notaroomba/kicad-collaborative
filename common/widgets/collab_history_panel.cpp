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

#include <widgets/collab_history_panel.h>

#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>
#include <eda_base_frame.h>

#include <wx/app.h>
#include <wx/button.h>
#include <wx/dataview.h>
#include <wx/msgdlg.h>
#include <wx/sizer.h>
#include <wx/datetime.h>
#include <wx/textdlg.h>
#include <wx/utils.h>


/// "2026-11-11T20:38:04.123+00:00" as local time, "2026-11-11 15:38".
static wxString localTime( const std::string& aIso )
{
    wxDateTime when;
    wxString   text = wxString::FromUTF8( aIso ).Left( 19 );

    if( !when.ParseISOCombined( text ) )
    {
        text.Replace( wxS( "T" ), wxS( " " ) );
        return text.Left( 16 );
    }

    return when.MakeFromTimezone( wxDateTime::UTC ).Format( wxS( "%Y-%m-%d %H:%M" ) );
}


COLLAB_HISTORY_PANEL::COLLAB_HISTORY_PANEL( wxWindow* aParent, EDA_BASE_FRAME* aFrame ) :
        wxPanel( aParent, wxID_ANY ),
        m_frame( aFrame ),
        m_alive( std::make_shared<bool>( true ) )
{
    wxBoxSizer* top = new wxBoxSizer( wxVERTICAL );

    m_list = new wxDataViewListCtrl( this, wxID_ANY );
    m_list->AppendTextColumn( _( "Version" ), wxDATAVIEW_CELL_INERT, 150 );
    m_list->AppendTextColumn( _( "By" ), wxDATAVIEW_CELL_INERT, 80 );
    m_list->AppendTextColumn( _( "When" ), wxDATAVIEW_CELL_INERT, 110 );
    top->Add( m_list, 1, wxEXPAND | wxALL, 4 );

    wxBoxSizer* buttons = new wxBoxSizer( wxHORIZONTAL );
    m_checkpointBtn = new wxButton( this, wxID_ANY, _( "Save Version..." ) );
    m_restoreBtn = new wxButton( this, wxID_ANY, _( "Restore..." ) );
    m_timelineBtn = new wxButton( this, wxID_ANY, _( "Timeline and Branches..." ) );
    m_timelineBtn->SetToolTip( _( "Open this project's history in the web editor: scrub through "
                                  "every edit, restore any point, and work with branches" ) );
    buttons->Add( m_checkpointBtn, 0, wxRIGHT, 4 );
    buttons->Add( m_restoreBtn, 0, wxRIGHT, 4 );
    buttons->AddStretchSpacer();
    buttons->Add( m_timelineBtn, 0 );
    top->Add( buttons, 0, wxEXPAND | wxLEFT | wxRIGHT | wxBOTTOM, 4 );

    SetSizer( top );

    m_checkpointBtn->Bind( wxEVT_BUTTON, [this]( wxCommandEvent& ) { onCheckpoint(); } );
    m_restoreBtn->Bind( wxEVT_BUTTON, [this]( wxCommandEvent& ) { onRestore(); } );
    m_timelineBtn->Bind( wxEVT_BUTTON, [this]( wxCommandEvent& ) { onOpenTimeline(); } );

    m_list->Bind( wxEVT_DATAVIEW_SELECTION_CHANGED,
                  [this]( wxDataViewEvent& )
                  {
                      m_restoreBtn->Enable( selectedRow() >= 0 );
                  } );

    // Somebody (here, in another editor or in the browser) saved, restored, branched or
    // merged: the list follows without anyone pressing a button.
    COLLAB_SESSION::Get().AddVersionsListener( this,
            [this]( const wxString& )
            {
                RefreshHistory();
            } );

    SetProject( wxEmptyString );
}


COLLAB_HISTORY_PANEL::~COLLAB_HISTORY_PANEL()
{
    *m_alive = false;
    COLLAB_SESSION::Get().RemoveVersionsListener( this );
}


void COLLAB_HISTORY_PANEL::SetProject( const wxString& aProjectId )
{
    m_projectId = aProjectId;

    bool active = !m_projectId.IsEmpty();

    m_checkpointBtn->Enable( active );
    m_timelineBtn->Enable( active );
    m_restoreBtn->Enable( false );

    m_list->DeleteAllItems();
    m_rowIds.clear();
    m_rowNames.clear();

    if( active )
        RefreshHistory();
}


void COLLAB_HISTORY_PANEL::RefreshHistory()
{
    if( m_projectId.IsEmpty() )
        return;

    // The notice arrives once per open document; one fetch at a time, and one more after it
    // if anything was announced meanwhile.
    if( m_fetching )
    {
        m_fetchAgain = true;
        return;
    }

    m_fetching = true;

    std::shared_ptr<bool> alive = m_alive;
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
    std::string projectId = m_projectId.ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, server, token, projectId]()
            {
                std::optional<nlohmann::json> listing = COLLAB_REST::ListVersions(
                        wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                        wxString::FromUTF8( projectId ) );

                bool           ok = listing && listing->contains( "versions" );
                nlohmann::json versions = ok ? ( *listing )[ "versions" ] : nlohmann::json::array();

                wxTheApp->CallAfter(
                        [this, alive, ok, versions, projectId]()
                        {
                            if( !*alive )
                                return;

                            m_fetching = false;

                            // A failed fetch leaves the list as it was rather than emptying it.
                            if( ok && m_projectId.ToStdString( wxConvUTF8 ) == projectId )
                                populate( versions );

                            if( m_fetchAgain )
                            {
                                m_fetchAgain = false;
                                RefreshHistory();
                            }
                        } );
            } );
}


void COLLAB_HISTORY_PANEL::populate( const nlohmann::json& aListing )
{
    // Keep the selection across a refresh: the list refills whenever anyone saves a version.
    wxString selected;
    int      was = selectedRow();

    if( was >= 0 )
        selected = m_rowIds[ was ];

    m_list->DeleteAllItems();
    m_rowIds.clear();
    m_rowNames.clear();

    // The server lists versions newest first.  Two versions may carry the same name; each is
    // a row of its own with its own author and time.
    for( const nlohmann::json& v : aListing )
    {
        if( !v.is_object() || !v.contains( "id" ) || !v[ "id" ].is_string() )
            continue;

        wxString id = wxString::FromUTF8( v[ "id" ].get<std::string>() );
        wxString name;

        if( v.contains( "name" ) && v[ "name" ].is_string() )
            name = wxString::FromUTF8( v[ "name" ].get<std::string>() );

        if( name.IsEmpty() )
            name = _( "Kept automatically" );

        wxString by;

        if( v.contains( "author" ) && v[ "author" ].is_object() )
        {
            const nlohmann::json& author = v[ "author" ];

            if( author.contains( "name" ) && author[ "name" ].is_string() )
                by = wxString::FromUTF8( author[ "name" ].get<std::string>() );

            if( by.IsEmpty() && author.contains( "login" ) && author[ "login" ].is_string() )
                by = wxString::FromUTF8( author[ "login" ].get<std::string>() );
        }

        wxVector<wxVariant> row;
        row.push_back( wxVariant( name ) );
        row.push_back( wxVariant( by ) );
        row.push_back( wxVariant( localTime( v.value( "createdAt", "" ) ) ) );

        m_list->AppendItem( row );
        m_rowIds.push_back( id );
        m_rowNames.push_back( name );

        if( id == selected )
            m_list->SelectRow( (unsigned) m_rowIds.size() - 1 );
    }

    m_restoreBtn->Enable( selectedRow() >= 0 );
}


int COLLAB_HISTORY_PANEL::selectedRow() const
{
    int row = m_list->GetSelectedRow();

    if( row == wxNOT_FOUND || row < 0 || row >= (int) m_rowIds.size() )
        return -1;

    return row;
}


void COLLAB_HISTORY_PANEL::onOpenTimeline()
{
    if( m_projectId.IsEmpty() )
        return;

    wxString url = COLLAB_SESSION::ServerUrl() + wxS( "/p/" ) + m_projectId + wxS( "/edit" );

    if( !wxLaunchDefaultBrowser( url ) )
        m_frame->ShowInfoBarError( wxString::Format( _( "Could not open %s in a browser." ), url ) );
}


void COLLAB_HISTORY_PANEL::onCheckpoint()
{
    wxTextEntryDialog dlg( this, _( "Name the project as it is now:" ), _( "Save Version" ) );

    if( dlg.ShowModal() != wxID_OK )
        return;

    wxString name = dlg.GetValue().Trim( true ).Trim( false );

    if( name.IsEmpty() )
        return;

    std::shared_ptr<bool> alive = m_alive;
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
    std::string projectId = m_projectId.ToStdString( wxConvUTF8 );
    std::string nameStd = name.ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, server, token, projectId, nameStd]()
            {
                std::optional<nlohmann::json> result = COLLAB_REST::CreateCheckpoint(
                        wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                        wxString::FromUTF8( projectId ), wxString::FromUTF8( nameStd ) );

                bool ok = result.has_value();

                wxTheApp->CallAfter(
                        [this, alive, ok]()
                        {
                            if( !*alive )
                                return;

                            if( !ok )
                            {
                                m_frame->ShowInfoBarError(
                                        _( "The version could not be saved." ) );
                            }

                            RefreshHistory();
                        } );
            } );
}


void COLLAB_HISTORY_PANEL::onRestore()
{
    int row = selectedRow();

    if( row < 0 )
        return;

    wxString id = m_rowIds[ row ];
    wxString name = m_rowNames[ row ];

    wxMessageDialog confirm(
            this,
            wxString::Format( _( "Restore the project to '%s'?\n\n"
                                 "The project as it is now is kept in the history first, so "
                                 "this can be taken back. Every connected editor synchronizes "
                                 "to the restored version automatically." ),
                              name ),
            _( "Restore Version" ), wxYES_NO | wxNO_DEFAULT | wxICON_QUESTION );

    if( confirm.ShowModal() != wxID_YES )
        return;

    std::shared_ptr<bool> alive = m_alive;
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
    std::string projectId = m_projectId.ToStdString( wxConvUTF8 );
    std::string idStd = id.ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, server, token, projectId, idStd]()
            {
                std::optional<nlohmann::json> result = COLLAB_REST::RestoreVersion(
                        wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                        wxString::FromUTF8( projectId ), wxString::FromUTF8( idStd ) );

                bool ok = result.has_value();

                wxTheApp->CallAfter(
                        [this, alive, ok]()
                        {
                            if( !*alive )
                                return;

                            if( ok )
                            {
                                m_frame->ShowInfoBarMsg(
                                        _( "Version restored; editors are synchronizing." ) );
                            }
                            else
                            {
                                m_frame->ShowInfoBarError(
                                        _( "The restore was refused. Only people who can edit "
                                           "the project can restore a version." ) );
                            }

                            RefreshHistory();
                        } );
            } );
}
