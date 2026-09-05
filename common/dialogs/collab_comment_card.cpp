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

#include <wx/bmpbuttn.h>
#include <wx/button.h>
#include <wx/datetime.h>
#include <wx/dcmemory.h>
#include <wx/graphics.h>
#include <wx/statbmp.h>
#include <wx/gdicmn.h>
#include <wx/panel.h>
#include <wx/settings.h>
#include <wx/sizer.h>
#include <wx/statline.h>
#include <wx/stattext.h>
#include <wx/textctrl.h>
#include <wx/time.h>

static const int CARD_WIDTH = 300;
static const int ANIM_MS = 160;

// KiCad's own palette, in a dark and a light cut so the card sits naturally on
// either appearance instead of forcing one.
struct CARD_THEME
{
    wxColour bg, border, text, muted, accent, input, inputText;
};

// Figma-style avatar: a coloured disc with the author's initial.
static wxBitmap avatarBitmap( const wxString& aLogin, int aSize, const CARD_THEME& aTheme )
{
    static const wxColour palette[] = { wxColour( 0xC8, 0x34, 0x34 ), wxColour( 0x4D, 0x7F, 0xC4 ),
                                        wxColour( 0x00, 0x96, 0x00 ), wxColour( 0xD1, 0x92, 0x00 ),
                                        wxColour( 0x84, 0x00, 0x84 ), wxColour( 0x00, 0x64, 0x64 ) };
    unsigned hash = 0;

    for( wxUniChar ch : aLogin )
        hash = hash * 31 + (unsigned) ch.GetValue();

    wxBitmap bmp( aSize, aSize, 32 );
    bmp.UseAlpha();
    wxMemoryDC dc( bmp );
    dc.SetBackground( *wxTRANSPARENT_BRUSH );
    dc.Clear();

    if( wxGraphicsContext* gc = wxGraphicsContext::Create( dc ) )
    {
        gc->SetBrush( wxBrush( palette[hash % 6] ) );
        gc->SetPen( *wxTRANSPARENT_PEN );
        gc->DrawEllipse( 0, 0, aSize, aSize );

        wxString initial = aLogin.IsEmpty() ? wxS( "?" ) : wxString( aLogin[0] ).Upper();
        wxFont   font = wxSystemSettings::GetFont( wxSYS_DEFAULT_GUI_FONT ).Bold();
        font.SetPointSize( aSize / 2 );
        gc->SetFont( font, *wxWHITE );
        double tw, th;
        gc->GetTextExtent( initial, &tw, &th );
        gc->DrawText( initial, ( aSize - tw ) / 2, ( aSize - th ) / 2 );
        delete gc;
    }

    dc.SelectObject( wxNullBitmap );
    return bmp;
}

// Small line icon (check mark or send arrow) in the theme's muted colour.
static wxBitmap iconBitmap( const wxString& aKind, int aSize, const wxColour& aColour, const wxColour& aBg )
{
    wxBitmap bmp( aSize, aSize, 32 );
    bmp.UseAlpha();
    wxMemoryDC dc( bmp );
    dc.SetBackground( *wxTRANSPARENT_BRUSH );
    dc.Clear();

    if( wxGraphicsContext* gc = wxGraphicsContext::Create( dc ) )
    {
        gc->SetBrush( wxBrush( aBg ) );
        gc->SetPen( *wxTRANSPARENT_PEN );
        gc->DrawEllipse( 0, 0, aSize, aSize );
        gc->SetPen( wxPen( aColour, 2 ) );
        wxGraphicsPath path = gc->CreatePath();
        double s = aSize;

        if( aKind == wxS( "check" ) )
        {
            path.MoveToPoint( s * 0.28, s * 0.52 );
            path.AddLineToPoint( s * 0.44, s * 0.68 );
            path.AddLineToPoint( s * 0.72, s * 0.36 );
        }
        else   // send: arrow up
        {
            path.MoveToPoint( s * 0.5, s * 0.72 );
            path.AddLineToPoint( s * 0.5, s * 0.3 );
            path.MoveToPoint( s * 0.32, s * 0.48 );
            path.AddLineToPoint( s * 0.5, s * 0.3 );
            path.AddLineToPoint( s * 0.68, s * 0.48 );
        }

        gc->StrokePath( path );
        delete gc;
    }

    dc.SelectObject( wxNullBitmap );
    return bmp;
}

static CARD_THEME cardTheme()
{
    if( wxSystemSettings::GetAppearance().IsDark() )
    {
        return { wxColour( 0x1E, 0x25, 0x30 ), wxColour( 0x3A, 0x46, 0x56 ), wxColour( 0xE9, 0xE7, 0xE0 ),
                 wxColour( 0xA9, 0xAF, 0xB8 ), wxColour( 0x6F, 0xC7, 0xC7 ), wxColour( 0x11, 0x18, 0x21 ),
                 wxColour( 0xE9, 0xE7, 0xE0 ) };
    }

    return { wxColour( 0xF5, 0xF4, 0xEF ), wxColour( 0xCF, 0xCD, 0xC5 ), wxColour( 0x1B, 0x1B, 0x1B ),
             wxColour( 0x5B, 0x5A, 0x55 ), wxColour( 0x00, 0x64, 0x64 ), wxColour( 0xFF, 0xFF, 0xFF ),
             wxColour( 0x1B, 0x1B, 0x1B ) };
}


COLLAB_COMMENT_CARD::COLLAB_COMMENT_CARD( wxWindow* aParent, REPLY_FN aReply, RESOLVE_FN aResolve ) :
        wxFrame( aParent, wxID_ANY, wxEmptyString, wxDefaultPosition, wxSize( CARD_WIDTH, 120 ),
                 wxFRAME_TOOL_WINDOW | wxFRAME_FLOAT_ON_PARENT | wxFRAME_NO_TASKBAR | wxBORDER_NONE ),
        m_reply( std::move( aReply ) ),
        m_resolve( std::move( aResolve ) )
{
    m_panel = new wxPanel( this, wxID_ANY, wxDefaultPosition, wxDefaultSize, wxBORDER_SIMPLE );
    m_panel->SetBackgroundColour( cardTheme().bg );
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

    const CARD_THEME theme = cardTheme();
    m_panel->SetBackgroundColour( theme.bg );

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

    const int pad = 12;
    wxFont    small = m_panel->GetFont().Smaller();

    auto addComment = [&]( const nlohmann::json& c, bool aFirst )
    {
        if( !aFirst )
        {
            wxStaticLine* rule = new wxStaticLine( m_panel );
            rule->SetBackgroundColour( theme.border );
            m_sizer->Add( rule, 0, wxEXPAND | wxLEFT | wxRIGHT | wxTOP, pad );
        }

        wxString login = wxString::FromUTF8( c.value( "authorLogin", "" ) );

        wxBoxSizer*     head = new wxBoxSizer( wxHORIZONTAL );
        wxStaticBitmap* avatar = new wxStaticBitmap( m_panel, wxID_ANY, avatarBitmap( login, 24, theme ) );
        wxStaticText*   who = new wxStaticText( m_panel, wxID_ANY, login );
        who->SetFont( who->GetFont().Bold() );
        who->SetForegroundColour( theme.text );

        wxStaticText* when = new wxStaticText( m_panel, wxID_ANY,
                                               relativeTime( c.value( "createdAt", "" ) ) );
        when->SetFont( small );
        when->SetForegroundColour( theme.muted );

        head->Add( avatar, 0, wxALIGN_CENTER_VERTICAL );
        head->AddSpacer( 8 );
        head->Add( who, 0, wxALIGN_CENTER_VERTICAL );
        head->AddSpacer( 8 );
        head->Add( when, 0, wxALIGN_CENTER_VERTICAL );

        if( aFirst )
        {
            // Figma keeps the resolve action at the thread's top-right corner.
            head->AddStretchSpacer();
            wxBitmapButton* resolve = new wxBitmapButton(
                    m_panel, wxID_ANY, iconBitmap( wxS( "check" ), 22, m_resolved ? wxColour( 0x3D, 0xBE, 0x3D ) : theme.muted, theme.bg ),
                    wxDefaultPosition, wxDefaultSize, wxBORDER_NONE );
            resolve->SetBackgroundColour( theme.bg );
            resolve->SetToolTip( m_resolved ? _( "Reopen" ) : _( "Resolve" ) );
            resolve->Bind( wxEVT_BUTTON, &COLLAB_COMMENT_CARD::onResolve, this );
            head->Add( resolve, 0, wxALIGN_CENTER_VERTICAL );
        }

        wxStaticText* body = new wxStaticText( m_panel, wxID_ANY,
                                               wxString::FromUTF8( c.value( "body", "" ) ) );
        body->SetForegroundColour( theme.text );
        body->Wrap( CARD_WIDTH - 2 * pad - 32 );

        // The message hangs under the name, indented past the avatar.
        wxBoxSizer* bodyRow = new wxBoxSizer( wxHORIZONTAL );
        bodyRow->AddSpacer( 32 );
        bodyRow->Add( body, 1 );

        m_sizer->Add( head, 0, wxEXPAND | wxLEFT | wxRIGHT | wxTOP, pad );
        m_sizer->Add( bodyRow, 0, wxEXPAND | wxLEFT | wxRIGHT, pad );
    };

    addComment( *root, true );

    for( const nlohmann::json* r : replies )
        addComment( *r, false );

    if( m_resolved )
    {
        wxStaticText* tag = new wxStaticText( m_panel, wxID_ANY, _( "\u2713 Resolved" ) );
        tag->SetFont( small );
        tag->SetForegroundColour( wxColour( 0x3D, 0xBE, 0x3D ) );
        m_sizer->Add( tag, 0, wxLEFT | wxRIGHT | wxTOP, pad );
    }

    // Reply row: the field with a round send button, Figma style.
    wxBoxSizer* row = new wxBoxSizer( wxHORIZONTAL );
    m_input = new wxTextCtrl( m_panel, wxID_ANY, wxEmptyString, wxDefaultPosition, wxSize( -1, 40 ),
                              wxTE_MULTILINE | wxTE_PROCESS_ENTER | wxBORDER_SIMPLE );
    m_input->SetHint( _( "Reply\u2026" ) );
    m_input->SetBackgroundColour( theme.input );
    m_input->SetForegroundColour( theme.inputText );
    m_input->Bind( wxEVT_TEXT_ENTER, &COLLAB_COMMENT_CARD::onReply, this );

    wxBitmapButton* send = new wxBitmapButton( m_panel, wxID_ANY,
                                               iconBitmap( wxS( "send" ), 28, *wxWHITE, theme.accent ),
                                               wxDefaultPosition, wxDefaultSize, wxBORDER_NONE );
    send->SetBackgroundColour( theme.bg );
    send->SetToolTip( _( "Reply (Enter)" ) );
    send->Bind( wxEVT_BUTTON, &COLLAB_COMMENT_CARD::onReply, this );

    row->Add( m_input, 1, wxALIGN_CENTER_VERTICAL );
    row->AddSpacer( 8 );
    row->Add( send, 0, wxALIGN_CENTER_VERTICAL );
    m_sizer->Add( row, 0, wxEXPAND | wxALL, pad );

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
