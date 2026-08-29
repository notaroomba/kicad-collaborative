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

#include "dialog_pcb_comments.h"

#include <wx/button.h>
#include <wx/dataview.h>
#include <wx/sizer.h>
#include <wx/stattext.h>
#include <wx/textctrl.h>

namespace
{
long long jsonNumber( const nlohmann::json& aObj, const char* aKey, long long aDefault )
{
    auto it = aObj.find( aKey );

    return it != aObj.end() && it->is_number() ? it->get<long long>() : aDefault;
}
} // namespace


DIALOG_PCB_COMMENTS::DIALOG_PCB_COMMENTS(
        wxWindow* aParent, const nlohmann::json* aComments, const VECTOR2I& aNewAnchor,
        std::function<void( const wxString&, long long )> aPost,
        std::function<void( long long, bool )> aResolve,
        std::function<void( const VECTOR2I& )> aFocus ) :
        wxDialog( aParent, wxID_ANY, _( "Comments" ), wxDefaultPosition, wxSize( 640, 460 ),
                  wxDEFAULT_DIALOG_STYLE | wxRESIZE_BORDER ),
        m_comments( aComments ),
        m_newAnchor( aNewAnchor ),
        m_post( std::move( aPost ) ),
        m_resolve( std::move( aResolve ) ),
        m_focus( std::move( aFocus ) )
{
    wxBoxSizer* top = new wxBoxSizer( wxVERTICAL );

    m_threads = new wxDataViewListCtrl( this, wxID_ANY );
    m_threads->AppendTextColumn( _( "Thread" ), wxDATAVIEW_CELL_INERT, 300 );
    m_threads->AppendTextColumn( _( "By" ), wxDATAVIEW_CELL_INERT, 110 );
    m_threads->AppendTextColumn( _( "Replies" ), wxDATAVIEW_CELL_INERT, 60 );
    m_threads->AppendTextColumn( _( "Status" ), wxDATAVIEW_CELL_INERT, 80 );
    top->Add( m_threads, 1, wxEXPAND | wxALL, 8 );

    m_thread = new wxTextCtrl( this, wxID_ANY, wxEmptyString, wxDefaultPosition,
                               wxSize( -1, 120 ), wxTE_MULTILINE | wxTE_READONLY );
    top->Add( m_thread, 0, wxEXPAND | wxLEFT | wxRIGHT, 8 );

    m_input = new wxTextCtrl( this, wxID_ANY, wxEmptyString, wxDefaultPosition, wxSize( -1, 54 ),
                              wxTE_MULTILINE );
    m_input->SetHint( _( "Write a reply, or a new comment pinned at the crosshair position" ) );
    top->Add( m_input, 0, wxEXPAND | wxALL, 8 );

    wxBoxSizer* buttons = new wxBoxSizer( wxHORIZONTAL );
    m_replyBtn = new wxButton( this, wxID_ANY, _( "Reply" ) );
    m_resolveBtn = new wxButton( this, wxID_ANY, _( "Resolve" ) );
    m_newBtn = new wxButton( this, wxID_ANY, _( "New Comment at Crosshair" ) );
    m_showBtn = new wxButton( this, wxID_ANY, _( "Show on Board" ) );
    buttons->Add( m_replyBtn, 0, wxRIGHT, 5 );
    buttons->Add( m_resolveBtn, 0, wxRIGHT, 5 );
    buttons->Add( m_showBtn, 0, wxRIGHT, 5 );
    buttons->Add( m_newBtn, 0, wxRIGHT, 5 );
    buttons->AddStretchSpacer();
    buttons->Add( new wxButton( this, wxID_CANCEL, _( "Close" ) ), 0 );
    top->Add( buttons, 0, wxEXPAND | wxALL, 8 );

    SetSizer( top );

    m_threads->Bind( wxEVT_DATAVIEW_SELECTION_CHANGED,
                     [this]( wxDataViewEvent& ) { onSelectionChanged(); } );

    m_replyBtn->Bind( wxEVT_BUTTON,
                      [this]( wxCommandEvent& )
                      {
                          wxString text = m_input->GetValue().Trim( true ).Trim( false );
                          long long root = selectedRootId();

                          if( text.IsEmpty() || root < 0 )
                              return;

                          m_input->Clear();
                          m_post( text, root );
                      } );

    m_resolveBtn->Bind( wxEVT_BUTTON,
                        [this]( wxCommandEvent& )
                        {
                            long long root = selectedRootId();

                            if( root < 0 )
                                return;

                            for( const nlohmann::json& c : *m_comments )
                            {
                                if( jsonNumber( c, "id", -1 ) == root )
                                {
                                    m_resolve( root, !c.value( "resolved", false ) );
                                    break;
                                }
                            }
                        } );

    m_showBtn->Bind( wxEVT_BUTTON,
                     [this]( wxCommandEvent& )
                     {
                         long long root = selectedRootId();

                         if( root < 0 )
                             return;

                         for( const nlohmann::json& c : *m_comments )
                         {
                             if( jsonNumber( c, "id", -1 ) == root )
                             {
                                 m_focus( VECTOR2I( jsonNumber( c, "x", 0 ),
                                                    jsonNumber( c, "y", 0 ) ) );
                                 break;
                             }
                         }
                     } );

    m_newBtn->Bind( wxEVT_BUTTON,
                    [this]( wxCommandEvent& )
                    {
                        wxString text = m_input->GetValue().Trim( true ).Trim( false );

                        if( text.IsEmpty() )
                            return;

                        m_input->Clear();
                        m_post( text, -1 );
                    } );

    Reload();
}


void DIALOG_PCB_COMMENTS::Reload()
{
    long long selected = selectedRootId();

    m_threads->DeleteAllItems();
    m_rowRootIds.clear();

    for( const nlohmann::json& c : *m_comments )
    {
        if( !c.is_object() || jsonNumber( c, "parentId", -1 ) >= 0 )
            continue;

        long long id = jsonNumber( c, "id", -1 );
        int       replies = 0;

        for( const nlohmann::json& other : *m_comments )
        {
            if( jsonNumber( other, "parentId", -1 ) == id )
                replies++;
        }

        wxString body = wxString::FromUTF8( c.value( "body", "" ) );
        body.Replace( wxS( "\n" ), wxS( " " ) );

        wxVector<wxVariant> row;
        row.push_back( wxVariant( body.Left( 80 ) ) );
        row.push_back( wxVariant( wxString::FromUTF8( c.value( "authorLogin", "" ) ) ) );
        row.push_back( wxVariant( wxString::Format( wxS( "%d" ), replies ) ) );
        row.push_back(
                wxVariant( c.value( "resolved", false ) ? _( "resolved" ) : _( "open" ) ) );

        m_threads->AppendItem( row );
        m_rowRootIds.push_back( id );

        if( id == selected )
            m_threads->SelectRow( m_threads->GetItemCount() - 1 );
    }

    onSelectionChanged();
}


long long DIALOG_PCB_COMMENTS::selectedRootId() const
{
    int row = m_threads ? m_threads->GetSelectedRow() : wxNOT_FOUND;

    if( row == wxNOT_FOUND || row < 0 || row >= (int) m_rowRootIds.size() )
        return -1;

    return m_rowRootIds[ row ];
}


void DIALOG_PCB_COMMENTS::onSelectionChanged()
{
    long long root = selectedRootId();

    m_thread->Clear();
    m_replyBtn->Enable( root >= 0 );
    m_resolveBtn->Enable( root >= 0 );
    m_showBtn->Enable( root >= 0 );

    if( root < 0 )
        return;

    for( const nlohmann::json& c : *m_comments )
    {
        if( jsonNumber( c, "id", -1 ) != root && jsonNumber( c, "parentId", -1 ) != root )
            continue;

        m_thread->AppendText( wxString::Format(
                wxS( "%s — %s\n%s\n\n" ), wxString::FromUTF8( c.value( "authorLogin", "" ) ),
                wxString::FromUTF8( c.value( "createdAt", "" ) ).Left( 16 ),
                wxString::FromUTF8( c.value( "body", "" ) ) ) );

        if( jsonNumber( c, "id", -1 ) == root )
        {
            m_resolveBtn->SetLabel( c.value( "resolved", false ) ? _( "Reopen" )
                                                                 : _( "Resolve" ) );
        }
    }
}
