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

#include "pcb_collab_tool.h"

#include <kiid.h>
#include <math/util.h>
#include <tool/actions.h>
#include <tools/pcb_selection.h>
#include <view/view.h>
#include <view/view_controls.h>

#include <wx/filename.h>


PCB_COLLAB_TOOL::PCB_COLLAB_TOOL() :
        PCB_TOOL_BASE( "pcbnew.Collab" ),
        m_presenceDirty( false )
{
    m_timer.SetOwner( this );
    Bind( wxEVT_TIMER, &PCB_COLLAB_TOOL::onTimer, this );
}


PCB_COLLAB_TOOL::~PCB_COLLAB_TOOL()
{
    m_timer.Stop();

    // The session is process-wide and outlives every frame, so a registration
    // left behind here is a dangling COLLAB_DOC_ADAPTER*.
    if( COLLAB_SESSION::Exists() )
        COLLAB_SESSION::Get().ForgetAdapter( this );
}


bool PCB_COLLAB_TOOL::Init()
{
    // Passive tool with no menus; the 100 ms tick is a cheap no-op until
    // eeschema brings the shared session live.
    m_timer.Start( 100 );

    return true;
}


void PCB_COLLAB_TOOL::Reset( RESET_REASON aReason )
{
    PCB_TOOL_BASE::Reset( aReason );

    if( aReason == SHUTDOWN )
    {
        // Leave the doc while the frame and view are still alive; the tool
        // destructor runs too late to touch either.
        m_timer.Stop();

        if( !m_docId.IsEmpty() )
            leaveDoc();

        return;
    }

    // A board (re)load rebuilds the view contents, dropping our overlay item and
    // invalidating cached selection boxes. Nothing else re-adds it: rebuild
    // otherwise only runs on a presence change, and idle peers send nothing.
    rebuildOverlay();
}


void PCB_COLLAB_TOOL::leaveDoc()
{
    COLLAB_SESSION::Get().LeaveDoc( m_docId );

    m_docId.clear();
    m_docPath.clear();
    m_lastSentState = nlohmann::json();
    m_presenceDirty = false;

    if( KIGFX::VIEW* view = getView() )
    {
        m_cursorItem.SetPeers( {} );
        view->Remove( &m_cursorItem );

        if( frame<PCB_EDIT_FRAME>()->GetCanvas() )
            frame<PCB_EDIT_FRAME>()->GetCanvas()->Refresh();
    }
}


wxString PCB_COLLAB_TOOL::boardFile() const
{
    if( !board() || board()->GetFileName().IsEmpty() )
        return wxEmptyString;

    wxFileName fn( board()->GetFileName() );
    fn.MakeRelativeTo( frame<PCB_EDIT_FRAME>()->Prj().GetProjectPath() );

    return fn.GetFullPath( wxPATH_UNIX );
}


int PCB_COLLAB_TOOL::onSelectionChange( const TOOL_EVENT& aEvent )
{
    m_presenceDirty = true;

    return 0;
}


void PCB_COLLAB_TOOL::onTimer( wxTimerEvent& aEvent )
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( !session.IsLive() )
    {
        // The doc registration is torn down here, on the tick after the session
        // ends, rather than from OnSessionStateChanged(): the session notifies
        // its adapters while iterating its doc map, so leaving mid-callback
        // would invalidate its iterator.
        if( !m_docId.IsEmpty() )
            leaveDoc();

        return;
    }

    wxString file = boardFile();

    if( !m_docId.IsEmpty() && m_docPath != file )
        leaveDoc();

    if( m_docId.IsEmpty() )
    {
        // eeschema owns the session but only joins schematic docs; find the
        // board's doc in the shared project doc list and join it ourselves.
        const nlohmann::json& docs = session.ProjectDocs();

        if( file.IsEmpty() || !docs.is_array() )
            return;

        for( const nlohmann::json& doc : docs )
        {
            if( doc.value( "docType", "" ) != "kicad_pcb" )
                continue;

            if( wxString::FromUTF8( doc.value( "path", "" ) ) != file )
                continue;

            wxString docId = wxString::FromUTF8( doc.value( "docId", "" ) );

            // A malformed entry would otherwise register an adapter under an
            // empty id that leaveDoc() can never match, and retry every tick.
            if( docId.IsEmpty() )
                continue;

            m_docId = docId;
            m_docPath = file;
            session.JoinDoc( m_docId, std::nullopt, this );
            break;
        }

        if( m_docId.IsEmpty() )
            return;
    }

    VECTOR2D cursor = getViewControls()->GetCursorPosition();
    BOX2D    viewport = getView()->GetViewport();

    nlohmann::json selectionIds = nlohmann::json::array();

    for( EDA_ITEM* item : selection() )
        selectionIds.push_back( item->m_Uuid.AsStdString() );

    nlohmann::json state = {
        { "cursor", { KiROUND( cursor.x ), KiROUND( cursor.y ) } },
        { "viewport",
          { KiROUND( viewport.GetOrigin().x ), KiROUND( viewport.GetOrigin().y ),
            KiROUND( viewport.GetSize().x ), KiROUND( viewport.GetSize().y ) } },
        { "selection", selectionIds },
        { "sheetFile", file.ToStdString( wxConvUTF8 ) },
    };

    if( !m_presenceDirty && state == m_lastSentState )
        return;

    m_presenceDirty = false;
    m_lastSentState = state;

    session.SendPresence( m_docId, state );
}


void PCB_COLLAB_TOOL::OnPresenceChanged()
{
    rebuildOverlay();
}


void PCB_COLLAB_TOOL::rebuildOverlay()
{
    KIGFX::VIEW* view = getView();

    if( !view || !board() )
        return;

    std::vector<REMOTE_PEER_DRAW> draws;
    wxString                      file = boardFile();

    if( !m_docId.IsEmpty() )
    {
        for( const auto& [clientId, peer] : COLLAB_SESSION::Get().Peers( m_docId ) )
        {
            if( !peer.state.is_object() )
                continue;

            // A peer only renders when they are looking at this board file.
            if( wxString::FromUTF8( peer.state.value( "sheetFile", "" ) ) != file )
                continue;

            REMOTE_PEER_DRAW draw;
            draw.label = peer.name.IsEmpty() ? peer.login : peer.name;
            draw.color = COLLAB_CURSOR_ITEM::ParsePeerColor( peer.color );

            if( peer.state.contains( "cursor" ) && peer.state[ "cursor" ].is_array()
                && peer.state[ "cursor" ].size() >= 2 )
            {
                draw.cursor = VECTOR2I( peer.state[ "cursor" ][ 0 ].get<int>(),
                                        peer.state[ "cursor" ][ 1 ].get<int>() );
                draw.hasCursor = true;
            }

            if( peer.state.contains( "selection" ) && peer.state[ "selection" ].is_array() )
            {
                for( const nlohmann::json& id : peer.state[ "selection" ] )
                {
                    if( !id.is_string() )
                        continue;

                    KIID kiid( wxString::FromUTF8( id.get<std::string>() ) );

                    if( BOARD_ITEM* item = board()->ResolveItem( kiid, true ) )
                        draw.selectionBoxes.push_back( item->GetBoundingBox() );
                }
            }

            if( draw.hasCursor || !draw.selectionBoxes.empty() )
                draws.push_back( std::move( draw ) );
        }
    }

    m_cursorItem.SetPeers( std::move( draws ) );

    // A board reload rebuilds the view wholesale, silently dropping our item,
    // so re-add it every time; Remove() is a no-op when it is not in the view.
    view->Remove( &m_cursorItem );
    view->Add( &m_cursorItem );
    view->Update( &m_cursorItem );

    if( frame<PCB_EDIT_FRAME>()->GetCanvas() )
        frame<PCB_EDIT_FRAME>()->GetCanvas()->Refresh();
}


void PCB_COLLAB_TOOL::setTransitions()
{
    Go( &PCB_COLLAB_TOOL::onSelectionChange, EVENTS::PointSelectedEvent );
    Go( &PCB_COLLAB_TOOL::onSelectionChange, EVENTS::SelectedEvent );
    Go( &PCB_COLLAB_TOOL::onSelectionChange, EVENTS::UnselectedEvent );
    Go( &PCB_COLLAB_TOOL::onSelectionChange, EVENTS::ClearedEvent );
}
