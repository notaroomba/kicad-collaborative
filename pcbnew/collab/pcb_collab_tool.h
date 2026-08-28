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

#pragma once

#include <collab/collab_cursor_item.h>
#include <collab/collab_session.h>
#include <tools/pcb_tool_base.h>

#include <wx/timer.h>


/**
 * Live-collaboration presence for the board editor: shares this frame's cursor,
 * viewport and selection with the collaboration server, and draws the other
 * participants' cursors and selections on the canvas.
 *
 * Passive tool with no actions of its own: sessions are started, joined and left
 * from eeschema.  The session only joins schematic docs itself, so this tool
 * watches the shared session and joins the board's own doc once it goes live.
 */
class PCB_COLLAB_TOOL : public wxEvtHandler, public PCB_TOOL_BASE, public COLLAB_DOC_ADAPTER
{
public:
    PCB_COLLAB_TOOL();
    ~PCB_COLLAB_TOOL() override;

    /// @copydoc TOOL_INTERACTIVE::Init()
    bool Init() override;

    /// @copydoc TOOL_INTERACTIVE::Reset()
    void Reset( RESET_REASON aReason ) override;

    // COLLAB_DOC_ADAPTER; all calls arrive on the UI thread.
    void OnPresenceChanged() override;

private:
    ///< Set up handlers for various events.
    void setTransitions() override;

    ///< Selection events only mark presence dirty; the timer tick throttles the send.
    int onSelectionChange( const TOOL_EVENT& aEvent );

    ///< 100 ms tick: join the board doc when the session is live, then send presence.
    void onTimer( wxTimerEvent& aEvent );

    ///< Leave the board doc and remove all remote cursors.
    void leaveDoc();

    ///< The board's file name, relative to the project (forward slashes).
    wxString boardFile() const;

    ///< Rebuild the remote-cursor overlay from the current peers and repaint.
    void rebuildOverlay();

private:
    wxTimer            m_timer;
    COLLAB_CURSOR_ITEM m_cursorItem;

    wxString       m_docId;      ///< server doc id of the joined board doc; empty when not joined
    wxString       m_docPath;    ///< project-relative board path the doc was joined for
    nlohmann::json m_lastSentState;
    bool           m_presenceDirty;
};
