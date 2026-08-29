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

#include <map>

#include <wx/app.h>
#include <wx/button.h>
#include <wx/dataview.h>
#include <wx/msgdlg.h>
#include <wx/sizer.h>
#include <wx/textdlg.h>


COLLAB_HISTORY_PANEL::COLLAB_HISTORY_PANEL( wxWindow* aParent, EDA_BASE_FRAME* aFrame ) :
        wxPanel( aParent, wxID_ANY ),
        m_frame( aFrame ),
        m_alive( std::make_shared<bool>( true ) )
{
    wxBoxSizer* top = new wxBoxSizer( wxVERTICAL );

    m_list = new wxDataViewListCtrl( this, wxID_ANY );
    m_list->AppendTextColumn( _( "Checkpoint" ), wxDATAVIEW_CELL_INERT, 140 );
    m_list->AppendTextColumn( _( "When" ), wxDATAVIEW_CELL_INERT, 110 );
    m_list->AppendTextColumn( _( "Docs" ), wxDATAVIEW_CELL_INERT, 44 );
    top->Add( m_list, 1, wxEXPAND | wxALL, 4 );

    wxBoxSizer* buttons = new wxBoxSizer( wxHORIZONTAL );
    m_checkpointBtn = new wxButton( this, wxID_ANY, _( "Checkpoint..." ) );
    m_restoreBtn = new wxButton( this, wxID_ANY, _( "Restore" ) );
    m_refreshBtn = new wxButton( this, wxID_ANY, _( "Refresh" ) );
    buttons->Add( m_checkpointBtn, 0, wxRIGHT, 4 );
    buttons->Add( m_restoreBtn, 0, wxRIGHT, 4 );
    buttons->AddStretchSpacer();
    buttons->Add( m_refreshBtn, 0 );
    top->Add( buttons, 0, wxEXPAND | wxLEFT | wxRIGHT | wxBOTTOM, 4 );

    SetSizer( top );

    m_checkpointBtn->Bind( wxEVT_BUTTON, [this]( wxCommandEvent& ) { onCheckpoint(); } );
    m_restoreBtn->Bind( wxEVT_BUTTON, [this]( wxCommandEvent& ) { onRestore(); } );
    m_refreshBtn->Bind( wxEVT_BUTTON, [this]( wxCommandEvent& ) { RefreshHistory(); } );

    m_list->Bind( wxEVT_DATAVIEW_SELECTION_CHANGED,
                  [this]( wxDataViewEvent& )
                  {
                      m_restoreBtn->Enable( !selectedName().IsEmpty() );
                  } );

    SetProject( wxEmptyString );
}


COLLAB_HISTORY_PANEL::~COLLAB_HISTORY_PANEL()
{
    *m_alive = false;
}


void COLLAB_HISTORY_PANEL::SetProject( const wxString& aProjectId )
{
    m_projectId = aProjectId;

    bool active = !m_projectId.IsEmpty();

    m_checkpointBtn->Enable( active );
    m_refreshBtn->Enable( active );
    m_restoreBtn->Enable( false );

    m_list->DeleteAllItems();
    m_rowNames.clear();

    if( active )
        RefreshHistory();
}


void COLLAB_HISTORY_PANEL::RefreshHistory()
{
    if( m_projectId.IsEmpty() )
        return;

    std::shared_ptr<bool> alive = m_alive;
    std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
    std::string token =
            COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
    std::string projectId = m_projectId.ToStdString( wxConvUTF8 );

    COLLAB_SESSION::Get().RunAsync(
            [this, alive, server, token, projectId]()
            {
                std::optional<nlohmann::json> listing = COLLAB_REST::ListCheckpoints(
                        wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                        wxString::FromUTF8( projectId ) );

                nlohmann::json checkpoints = listing && listing->contains( "checkpoints" )
                                                     ? ( *listing )[ "checkpoints" ]
                                                     : nlohmann::json::array();

                wxTheApp->CallAfter(
                        [this, alive, checkpoints, projectId]()
                        {
                            if( !*alive
                                || m_projectId.ToStdString( wxConvUTF8 ) != projectId )
                            {
                                return;
                            }

                            populate( checkpoints );
                        } );
            } );
}


void COLLAB_HISTORY_PANEL::populate( const nlohmann::json& aListing )
{
    m_list->DeleteAllItems();
    m_rowNames.clear();
    m_restoreBtn->Enable( false );

    // The server returns one row per document per checkpoint; the panel shows
    // one row per checkpoint name with its newest timestamp and doc count.
    struct GROUP
    {
        wxString newest;
        int      docs = 0;
    };

    std::map<wxString, GROUP>  groups;
    std::vector<wxString>      order;

    for( const nlohmann::json& row : aListing )
    {
        if( !row.is_object() )
            continue;

        wxString name = wxString::FromUTF8( row.value( "name", "" ) );

        if( name.IsEmpty() )
            continue;

        wxString when = wxString::FromUTF8( row.value( "createdAt", "" ) ).Left( 16 );
        when.Replace( wxS( "T" ), wxS( " " ) );

        auto [it, inserted] = groups.try_emplace( name );

        if( inserted )
            order.push_back( name );

        it->second.docs++;

        if( when > it->second.newest )
            it->second.newest = when;
    }

    // Newest checkpoint first.
    std::sort( order.begin(), order.end(),
               [&]( const wxString& a, const wxString& b )
               {
                   return groups[ a ].newest > groups[ b ].newest;
               } );

    for( const wxString& name : order )
    {
        wxVector<wxVariant> row;
        row.push_back( wxVariant( name ) );
        row.push_back( wxVariant( groups[ name ].newest ) );
        row.push_back( wxVariant( wxString::Format( wxS( "%d" ), groups[ name ].docs ) ) );

        m_list->AppendItem( row );
        m_rowNames.push_back( name );
    }
}


wxString COLLAB_HISTORY_PANEL::selectedName() const
{
    int row = m_list->GetSelectedRow();

    if( row == wxNOT_FOUND || row < 0 || row >= (int) m_rowNames.size() )
        return wxEmptyString;

    return m_rowNames[ row ];
}


void COLLAB_HISTORY_PANEL::onCheckpoint()
{
    wxTextEntryDialog dlg( this, _( "Name this checkpoint:" ), _( "Create Checkpoint" ) );

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
                                        _( "The checkpoint could not be created." ) );
                            }

                            RefreshHistory();
                        } );
            } );
}


void COLLAB_HISTORY_PANEL::onRestore()
{
    wxString name = selectedName();

    if( name.IsEmpty() )
        return;

    wxMessageDialog confirm(
            this,
            wxString::Format( _( "Restore the project to checkpoint '%s'?\n\n"
                                 "Every connected editor will synchronize to the restored "
                                 "version automatically." ),
                              name ),
            _( "Restore Checkpoint" ), wxYES_NO | wxNO_DEFAULT | wxICON_WARNING );

    if( confirm.ShowModal() != wxID_YES )
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
                std::optional<nlohmann::json> result = COLLAB_REST::RestoreCheckpoint(
                        wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                        wxString::FromUTF8( projectId ), wxString::FromUTF8( nameStd ) );

                bool ok = result.has_value();

                wxTheApp->CallAfter(
                        [this, alive, ok]()
                        {
                            if( !*alive )
                                return;

                            if( ok )
                            {
                                m_frame->ShowInfoBarMsg(
                                        _( "Checkpoint restored; editors are "
                                           "synchronizing." ) );
                            }
                            else
                            {
                                m_frame->ShowInfoBarError(
                                        _( "The restore was refused (only the project "
                                           "owner can restore)." ) );
                            }

                            RefreshHistory();
                        } );
            } );
}
