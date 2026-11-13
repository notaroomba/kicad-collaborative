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

#include <dialogs/panel_wakatime.h>
#include <wakatime.h>

#include <wx/busyinfo.h>
#include <wx/button.h>
#include <wx/checkbox.h>
#include <wx/choice.h>
#include <wx/hyperlink.h>
#include <wx/sizer.h>
#include <wx/statbox.h>
#include <wx/stattext.h>
#include <wx/textctrl.h>
#include <wx/utils.h>


namespace
{
struct SERVER
{
    const wxChar* label;
    const wxChar* apiUrl;     ///< empty: WakaTime's own
    const wxChar* keyUrl;
};

// the same choices as the browser editor's page (server/src/timetrack.rs presets)
const SERVER SERVERS[] = {
    { wxT( "WakaTime" ), wxT( "" ), wxT( "https://wakatime.com/settings/api-key" ) },
    { wxT( "Hackatime" ), wxT( "https://hackatime.hackclub.com/api/hackatime/v1" ),
      wxT( "https://hackatime.hackclub.com/my/settings" ) },
    { wxT( "Wakapi" ), wxT( "https://wakapi.dev/api/compat/wakatime/v1" ), wxT( "https://wakapi.dev/settings" ) },
};
const int CUSTOM = (int) std::size( SERVERS );
} // namespace


PANEL_WAKATIME::PANEL_WAKATIME( wxWindow* aParent ) :
        RESETTABLE_PANEL( aParent )
{
    wxBoxSizer* top = new wxBoxSizer( wxVERTICAL );

    wxStaticBoxSizer* box = new wxStaticBoxSizer( wxVERTICAL, this, _( "WakaTime" ) );
    wxWindow*         sb = box->GetStaticBox();

    m_enabled = new wxCheckBox( sb, wxID_ANY, _( "Send heartbeats to WakaTime while I work" ) );
    m_enabled->SetToolTip( _( "Like WakaTime's editor plugins: a heartbeat at most every two minutes "
                              "while you move, draw or edit, and at once on another file." ) );
    box->Add( m_enabled, 0, wxALL, 5 );

    wxFlexGridSizer* grid = new wxFlexGridSizer( 0, 2, 5, 8 );
    grid->AddGrowableCol( 1 );
    grid->SetFlexibleDirection( wxHORIZONTAL );

    grid->Add( new wxStaticText( sb, wxID_ANY, _( "Server:" ) ), 0, wxALIGN_CENTER_VERTICAL );
    m_server = new wxChoice( sb, wxID_ANY );

    for( const SERVER& s : SERVERS )
        m_server->Append( s.label );

    m_server->Append( _( "Custom" ) );
    grid->Add( m_server, 0, wxALIGN_CENTER_VERTICAL );

    grid->Add( new wxStaticText( sb, wxID_ANY, _( "API URL:" ) ), 0, wxALIGN_CENTER_VERTICAL );
    m_url = new wxTextCtrl( sb, wxID_ANY );
    m_url->SetHint( wxT( "https://api.wakatime.com/api/v1" ) );
    grid->Add( m_url, 1, wxEXPAND | wxALIGN_CENTER_VERTICAL );

    grid->Add( new wxStaticText( sb, wxID_ANY, _( "API key:" ) ), 0, wxALIGN_CENTER_VERTICAL );
    m_key = new wxTextCtrl( sb, wxID_ANY, wxEmptyString, wxDefaultPosition, wxDefaultSize, wxTE_PASSWORD );
    grid->Add( m_key, 1, wxEXPAND | wxALIGN_CENTER_VERTICAL );

    grid->AddSpacer( 0 );
    wxBoxSizer* keyRow = new wxBoxSizer( wxHORIZONTAL );
    m_keyNote = new wxStaticText( sb, wxID_ANY, wxEmptyString );
    keyRow->Add( m_keyNote, 0, wxALIGN_CENTER_VERTICAL | wxRIGHT, 10 );
    m_keyLink = new wxHyperlinkCtrl( sb, wxID_ANY, _( "Get your API key" ), SERVERS[0].keyUrl );
    keyRow->Add( m_keyLink, 0, wxALIGN_CENTER_VERTICAL );
    grid->Add( keyRow, 0 );

    box->Add( grid, 0, wxEXPAND | wxALL, 5 );

    wxBoxSizer* testRow = new wxBoxSizer( wxHORIZONTAL );
    wxButton*   test = new wxButton( sb, wxID_ANY, _( "Send Test Heartbeat" ) );
    testRow->Add( test, 0, wxALIGN_CENTER_VERTICAL | wxRIGHT, 10 );
    m_status = new wxStaticText( sb, wxID_ANY, wxEmptyString );
    testRow->Add( m_status, 1, wxALIGN_CENTER_VERTICAL );
    box->Add( testRow, 0, wxEXPAND | wxALL, 5 );

    top->Add( box, 0, wxEXPAND | wxALL, 5 );

    wxStaticBoxSizer* about = new wxStaticBoxSizer( wxVERTICAL, this, _( "How It Works" ) );
    wxStaticText*     text = new wxStaticText( about->GetStaticBox(), wxID_ANY,
            wxString::Format( _( "The key and server are kept in %s, which every WakaTime plugin "
                                 "shares.  Hackatime and Wakapi speak the WakaTime API: pick one, "
                                 "or Custom for any other server.  Projects online in Junction also "
                                 "show the time spent on them on the Junction website." ),
                              WAKATIME::ConfigPath() ) );
    text->Wrap( 560 );
    about->Add( text, 0, wxALL, 5 );
    m_cli = new wxStaticText( about->GetStaticBox(), wxID_ANY, wxEmptyString );
    about->Add( m_cli, 0, wxALL, 5 );
    top->Add( about, 0, wxEXPAND | wxALL, 5 );

    SetSizer( top );
    Layout();
    top->Fit( this );

    m_server->Bind( wxEVT_CHOICE, &PANEL_WAKATIME::onServer, this );
    test->Bind( wxEVT_BUTTON, &PANEL_WAKATIME::onTest, this );
}


void PANEL_WAKATIME::syncServer()
{
    int sel = m_server->GetSelection();

    if( sel >= 0 && sel < CUSTOM )
    {
        m_url->ChangeValue( *SERVERS[sel].apiUrl ? SERVERS[sel].apiUrl : wxT( "https://api.wakatime.com/api/v1" ) );
        m_url->Enable( false );
        m_keyLink->SetURL( SERVERS[sel].keyUrl );
        m_keyLink->Show();
    }
    else
    {
        m_url->ChangeValue( m_customUrl );
        m_url->Enable( true );
        m_keyLink->Hide();
    }

    Layout();
}


void PANEL_WAKATIME::onServer( wxCommandEvent& aEvent )
{
    syncServer();
}


bool PANEL_WAKATIME::TransferDataToWindow()
{
    WAKATIME::CONFIG cfg = WAKATIME::ReadConfig();

    m_enabled->SetValue( cfg.enabled );
    m_savedKey = cfg.apiKey;
    m_key->ChangeValue( wxEmptyString );
    // a password field's hint is not drawn on every platform, so say it beside the field too
    m_keyNote->SetLabel( cfg.apiKey.IsEmpty()
                                 ? _( "No key saved yet." )
                                 : wxString::Format( _( "A key ending in %s is saved; type a new one to replace it." ),
                                                     cfg.apiKey.Right( 4 ) ) );
    m_key->SetHint( cfg.apiKey.IsEmpty() ? wxString( wxT( "waka_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" ) )
                                         : wxString( _( "Leave empty to keep the saved key" ) ) );

    int sel = CUSTOM;

    for( int i = 0; i < CUSTOM; ++i )
    {
        if( cfg.apiUrl == SERVERS[i].apiUrl )
            sel = i;
    }

    m_customUrl = sel == CUSTOM ? cfg.apiUrl : wxString();
    m_server->SetSelection( sel );
    syncServer();

    wxString cli = WAKATIME::FindCli();
    m_cli->SetLabel( cli.IsEmpty()
                             ? _( "wakatime-cli is not installed, so Junction sends the heartbeats itself." )
                             : wxString::Format( _( "Heartbeats go through wakatime-cli (%s), which keeps them "
                                                    "while you are offline." ), cli ) );

    wxString last = WAKATIME::Get().LastStatus();
    m_status->SetLabel( last.IsEmpty() ? wxString() : wxString::Format( _( "Last heartbeat: %s" ), last ) );
    Layout();
    return true;
}


bool PANEL_WAKATIME::TransferDataFromWindow()
{
    WAKATIME::CONFIG cfg;
    cfg.enabled = m_enabled->GetValue();

    wxString key = m_key->GetValue().Strip( wxString::both );
    cfg.apiKey = key.IsEmpty() ? m_savedKey : key;

    int sel = m_server->GetSelection();
    cfg.apiUrl = sel >= 0 && sel < CUSTOM ? wxString( SERVERS[sel].apiUrl )
                                         : m_url->GetValue().Strip( wxString::both );

    if( sel == CUSTOM )
        m_customUrl = cfg.apiUrl;

    WAKATIME::CONFIG old = WAKATIME::ReadConfig();

    // nothing changed: leave the file (and its other plugins' lines) alone
    if( old.enabled == cfg.enabled && old.apiKey == cfg.apiKey && old.apiUrl == cfg.apiUrl )
        return true;

    if( !WAKATIME::WriteConfig( cfg ) )
    {
        m_status->SetLabel( wxString::Format( _( "Could not write %s." ), WAKATIME::ConfigPath() ) );
        return false;
    }

    m_savedKey = cfg.apiKey;
    return true;
}


void PANEL_WAKATIME::onTest( wxCommandEvent& aEvent )
{
    if( !TransferDataFromWindow() )
        return;

    m_status->SetLabel( _( "Sending a test heartbeat..." ) );
    m_status->Update();

    wxString status;
    bool     ok;

    {
        wxBusyCursor busy;
        ok = WAKATIME::Get().SendTest( status );
    }

    m_status->SetLabel( status );
    m_status->SetForegroundColour( ok ? wxNullColour : wxColour( 200, 40, 40 ) );
    TransferDataToWindow();
    m_status->SetLabel( status );
    Layout();
}


void PANEL_WAKATIME::ResetPanel()
{
    m_enabled->SetValue( true );
    m_server->SetSelection( 0 );
    syncServer();
}
