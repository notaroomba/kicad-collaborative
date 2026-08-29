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

#include <functional>
#include <memory>

#include <collab/collab_auth.h>
#include <collab/collab_cursor_item.h>
#include <collab/collab_session.h>
#include <tools/pcb_tool_base.h>

#include <wx/datetime.h>
#include <wx/timer.h>

class PCB_COLLAB_SYNC;


/**
 * Live-collaboration presence for the board editor: shares this frame's cursor,
 * viewport and selection with the collaboration server, and draws the other
 * participants' cursors and selections on the canvas.
 *
 * A session can be started or joined from here, or from eeschema.  In the latter
 * case the schematic editor only joins schematic docs, so this tool watches the
 * shared session and joins the board's own doc once it goes live.
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

    ///< Upload the current project and copy a share link to the clipboard.
    int StartSession( const TOOL_EVENT& aEvent );

    ///< Join a project from a pasted share link.
    int JoinSession( const TOOL_EVENT& aEvent );

    ///< Leave the session and remove all remote cursors.
    int LeaveSession( const TOOL_EVENT& aEvent );

    ///< True while this frame is connected to a collaboration session.
    bool sessionActive() const { return m_ownsSession || !m_docId.IsEmpty(); }

    // COLLAB_DOC_ADAPTER; all calls arrive on the UI thread.
    void OnPresenceChanged() override;
    void OnSessionStateChanged() override;
    void OnRemoteOp( const nlohmann::json& aOpMsg ) override;
    void OnOpsTail( const nlohmann::json& aOpsMsg ) override;
    void OnSnapshot( const nlohmann::json& aSnapshotMsg ) override;
    void OnAck( const wxString& aClientOpId, long long aSeq ) override;
    void OnOpRejected( const wxString& aClientOpId, const wxString& aCode ) override;
    void OnSnapshotRequest() override;
    void OnReset( const wxString& aDocId, long long aSeq ) override;

    ///< The live-editing sync engine, or nullptr when the board doc is not joined.
    PCB_COLLAB_SYNC* GetSync() const { return m_sync.get(); }

private:
    ///< Set up handlers for various events.
    void setTransitions() override;

    ///< Selection events only mark presence dirty; the timer tick throttles the send.
    int onSelectionChange( const TOOL_EVENT& aEvent );

    ///< 100 ms tick: join the board doc when the session is live, then send presence.
    void onTimer( wxTimerEvent& aEvent );

    ///< Run aContinuation with a bearer token, signing in interactively if needed.
    void withSignIn( std::function<void( const wxString& aToken )> aContinuation );

    void joinWithToken( const wxString& aToken, const wxString& aLinkToken );
    void startWithToken( const wxString& aToken );

    ///< Connect and join the board doc of aProject (a server project json).
    void beginSession( const nlohmann::json& aProject, const wxString& aToken,
                       const wxString& aLinkToken );
    void endSession();

    ///< Leave the board doc and remove all remote cursors.
    void leaveDoc();

    ///< Register for the board doc and stand up the edit-sync engine.
    void joinDoc( const wxString& aDocId, const wxString& aDocPath );

    ///< Rejoin the live session recorded beside a cloud project copy (link.json),
    ///< silently.  No-op without a stored token or link file.
    void tryAutoJoin();

    ///< The board's file name, relative to the project (forward slashes).
    wxString boardFile() const;

    ///< Rebuild the remote-cursor overlay from the current peers and repaint.
    void rebuildOverlay();

private:
    COLLAB_AUTH        m_auth;
    wxTimer            m_timer;
    COLLAB_CURSOR_ITEM m_cursorItem;

    std::unique_ptr<PCB_COLLAB_SYNC> m_sync;  ///< live while the board doc is joined

    wxString       m_docId;      ///< server doc id of the joined board doc; empty when not joined
    wxString       m_docPath;    ///< project-relative board path the doc was joined for
    nlohmann::json m_lastSentState;
    wxDateTime     m_lastPresenceSend;  ///< for the idle keepalive
    wxDateTime     m_lastRejectNotice;  ///< throttles the rejected-edit infobar
    bool           m_presenceDirty;
    bool           m_ownsSession; ///< this tool connected the session, rather than eeschema
    wxString       m_autoJoinProject;   ///< project path an auto-join was attempted for
};
