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

#include <dialogs/collab_comment_card.h>

#include <algorithm>
#include <vector>

#include <wx/button.h>
#include <wx/datetime.h>
#include <wx/gdicmn.h>
#include <wx/panel.h>
#include <wx/sizer.h>
#include <wx/stattext.h>
#include <wx/textctrl.h>
#include <wx/time.h>

static const int CARD_WIDTH = 300;
static const int ANIM_MS = 160;


COLLAB_COMMENT_CARD::COLLAB_COMMENT_CARD( wxWindow* aParent, REPLY_FN aReply, RESOLVE_FN aResolve ) :
        wxFrame( aParent, wxID_ANY, wxEmptyString, wxDefaultPosition, wxSize( CARD_WIDTH, 120 ),
                 wxFRAME_TOOL_WINDOW | wxFRAME_FLOAT_ON_PARENT | wxFRAME_NO_TASKBAR | wxBORDER_NONE ),
        m_reply( std::move( aReply ) ),
        m_resolve( std::move( aResolve ) )
{
    m_panel = new wxPanel( this, wxID_ANY, wxDefaultPosition, wxDefaultSize, wxBORDER_SIMPLE );
    m_panel->SetBackgroundColour( wxColour( 0xF5, 0xF4, 0xEF ) );   // schematic paper
    m_sizer = new wxBoxSizer( wxVERTICAL );
    m_panel->SetSizer( m_sizer );

    wxBoxSizer* outer = new wxBoxSizer( wxVERTICAL );
    outer->Add( m_panel, 1, wxEXPAND );
    SetSizer( outer );

    m_anim.Bind( wxEVT_TIMER, &COLLAB_COMMENT_CARD::onAnimate, this );
}


wxString COLLAB_COMMENT_CARD::relativeTime( const std::string& aIso )
{
    wxString iso = wxString::FromUTF8( aIso );
    wxString stamp = iso.BeforeFirst( '.' );
    stamp.Replace( wxS( "Z" ), wxEmptyString );

    wxDateTime dt;
    wxString::const_iterator end;

    if( stamp.IsEmpty() || !dt.ParseISOCombined( stamp ) )
        return iso;

    // Server stamps are UTC.
    dt.MakeFromTimezone( wxDateTime::UTC );

    wxTimeSpan span = wxDateTime::Now() - dt;
    long        mins = span.GetMinutes();

    if( mins < 1 )
        return _( "just now" );
    if( mins < 60 )
        return wxString::Format( _( "%ldm ago" ), mins );
    if( mins < 60 * 24 )
        return wxString::Format( _( "%ldh ago" ), mins / 60 );

    return wxString::Format( _( "%ldd ago" ), mins / ( 60 * 24 ) );
}


void COLLAB_COMMENT_CARD::rebuild( const nlohmann::json& aComments )
{
    m_sizer->Clear( true );
    m_input = nullptr;
    m_resolveBtn = nullptr;

    const nlohmann::json*              root = nullptr;
    std::vector<const nlohmann::json*> replies;

    for( const nlohmann::json& c : aComments )
    {
        if( !c.is_object() )
            continue;

        if( c.value( "id", -1LL ) == m_rootId )
            root = &c;
        else if( c.value( "parentId", -1LL ) == m_rootId )
            replies.push_back( &c );
    }

    if( !root )
    {
        m_rootId = -1;
        return;
    }

    m_resolved = root->value( "resolved", false );

    auto addComment = [&]( const nlohmann::json& c )
    {
        wxString who = wxString::FromUTF8( c.value( "authorLogin", "" ) );
        wxString when = relativeTime( c.value( "createdAt", "" ) );

        wxStaticText* head = new wxStaticText( m_panel, wxID_ANY, who + wxS( "  ·  " ) + when );
        head->SetFont( head->GetFont().Bold() );
        head->SetForegroundColour( wxColour( 0x00, 0x64, 0x64 ) );

        wxStaticText* body = new wxStaticText( m_panel, wxID_ANY,
                                               wxString::FromUTF8( c.value( "body", "" ) ) );
        body->Wrap( CARD_WIDTH - 28 );

        m_sizer->Add( head, 0, wxLEFT | wxRIGHT | wxTOP, 10 );
        m_sizer->Add( body, 0, wxLEFT | wxRIGHT | wxBOTTOM, 10 );
    };

    addComment( *root );

    for( const nlohmann::json* r : replies )
        addComment( *r );

    if( m_resolved )
    {
        wxStaticText* tag = new wxStaticText( m_panel, wxID_ANY, _( "Resolved" ) );
        tag->SetForegroundColour( wxColour( 0x00, 0x96, 0x00 ) );
        m_sizer->Add( tag, 0, wxLEFT | wxRIGHT | wxBOTTOM, 10 );
    }

    m_input = new wxTextCtrl( m_panel, wxID_ANY, wxEmptyString, wxDefaultPosition, wxSize( -1, 54 ),
                              wxTE_MULTILINE | wxTE_PROCESS_ENTER );
    m_input->SetHint( _( "Reply…" ) );
    m_input->Bind( wxEVT_TEXT_ENTER, &COLLAB_COMMENT_CARD::onReply, this );
    m_sizer->Add( m_input, 0, wxEXPAND | wxLEFT | wxRIGHT, 10 );

    wxBoxSizer* row = new wxBoxSizer( wxHORIZONTAL );
    m_resolveBtn = new wxButton( m_panel, wxID_ANY, m_resolved ? _( "Reopen" ) : _( "Resolve" ),
                                 wxDefaultPosition, wxDefaultSize, wxBU_EXACTFIT );
    m_resolveBtn->Bind( wxEVT_BUTTON, &COLLAB_COMMENT_CARD::onResolve, this );

    wxButton* reply = new wxButton( m_panel, wxID_ANY, _( "Reply" ), wxDefaultPosition,
                                    wxDefaultSize, wxBU_EXACTFIT );
    reply->Bind( wxEVT_BUTTON, &COLLAB_COMMENT_CARD::onReply, this );

    row->Add( m_resolveBtn, 0 );
    row->AddStretchSpacer();
    row->Add( reply, 0 );
    m_sizer->Add( row, 0, wxEXPAND | wxALL, 10 );

    m_panel->Layout();
    wxSize sz = m_sizer->ComputeFittingClientSize( m_panel );
    sz.x = CARD_WIDTH;
    m_panel->SetMinSize( sz );
    SetClientSize( sz );
    Layout();
}


void COLLAB_COMMENT_CARD::ShowThread( const nlohmann::json& aComments, long long aRootId,
                                      const wxPoint& aScreenAnchor )
{
    m_rootId = aRootId;
    rebuild( aComments );

    if( m_rootId < 0 )
    {
        HideCard();
        return;
    }

    wxSize sz = GetSize();
    wxRect screen = wxGetClientDisplayRect();

    // Beside the pin, to the right; flip to the left near the screen edge.
    int x = aScreenAnchor.x + 22;
    int y = aScreenAnchor.y - 16;

    if( x + sz.x > screen.GetRight() )
        x = aScreenAnchor.x - 22 - sz.x;

    if( y + sz.y > screen.GetBottom() )
        y = screen.GetBottom() - sz.y - 8;

    if( y < screen.GetTop() )
        y = screen.GetTop() + 8;

    m_animTo = wxPoint( x, y );
    m_animFrom = wxPoint( x + ( x > aScreenAnchor.x ? 14 : -14 ), y );

    Move( m_animFrom );
    SetTransparent( 0 );

#if defined( __WXMAC__ ) || defined( __WXMSW__ )
    ShowWithoutActivating();
#else
    Show();
#endif

    m_animStart = wxGetUTCTimeMillis();
    m_anim.Start( 16 );
}


void COLLAB_COMMENT_CARD::onAnimate( wxTimerEvent& aEvent )
{
    double f = std::min( 1.0, ( wxGetUTCTimeMillis() - m_animStart ).ToDouble() / ANIM_MS );
    double e = 1.0 - ( 1.0 - f ) * ( 1.0 - f );   // ease-out

    Move( wxPoint( m_animFrom.x + (int) ( ( m_animTo.x - m_animFrom.x ) * e ), m_animTo.y ) );
    SetTransparent( (wxByte) ( 255 * e ) );

    if( f >= 1.0 )
        m_anim.Stop();
}


void COLLAB_COMMENT_CARD::Reload( const nlohmann::json& aComments )
{
    if( !IsShown() || m_rootId < 0 )
        return;

    wxString draft = m_input ? m_input->GetValue() : wxString();
    bool     focused = m_input && m_input->HasFocus();

    rebuild( aComments );

    if( m_rootId < 0 )
    {
        HideCard();
        return;
    }

    if( m_input )
    {
        m_input->ChangeValue( draft );

        if( focused )
            m_input->SetFocus();
    }
}


void COLLAB_COMMENT_CARD::HideCard()
{
    m_anim.Stop();
    Hide();
    m_rootId = -1;
}


bool COLLAB_COMMENT_CARD::ContainsScreenPoint( const wxPoint& aPt ) const
{
    if( !IsShown() )
        return false;

    wxRect r = GetScreenRect();
    r.Inflate( 10, 10 );

    return r.Contains( aPt );
}


bool COLLAB_COMMENT_CARD::HasFocusedInput() const
{
    return IsShown() && m_input && ( m_input->HasFocus() || !m_input->IsEmpty() );
}


void COLLAB_COMMENT_CARD::onReply( wxCommandEvent& aEvent )
{
    if( !m_input || m_rootId < 0 )
        return;

    wxString body = m_input->GetValue();
    body.Trim( true ).Trim( false );

    if( body.IsEmpty() )
        return;

    m_input->Clear();

    if( m_reply )
        m_reply( body, m_rootId );
}


void COLLAB_COMMENT_CARD::onResolve( wxCommandEvent& aEvent )
{
    if( m_rootId >= 0 && m_resolve )
        m_resolve( m_rootId, !m_resolved );
}
