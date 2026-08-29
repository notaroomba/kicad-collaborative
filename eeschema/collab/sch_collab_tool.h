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
#include <map>
#include <memory>

#include <collab/collab_auth.h>
#include <collab/collab_cursor_item.h>
#include <collab/collab_session.h>
#include <sch_edit_frame.h>
#include <tools/sch_tool_base.h>

#include <wx/datetime.h>
#include <wx/timer.h>

class SCH_COLLAB_SYNC;


/**
 * Live-collaboration presence for the schematic editor: shares this frame's cursor,
 * viewport and selection with the collaboration server, and draws the other
 * participants' cursors and selections on the canvas.
 */
class SCH_COLLAB_TOOL : public wxEvtHandler, public SCH_TOOL_BASE<SCH_EDIT_FRAME>,
                        public COLLAB_DOC_ADAPTER
{
public:
    SCH_COLLAB_TOOL();
    ~SCH_COLLAB_TOOL() override;

    /// @copydoc TOOL_INTERACTIVE::Reset()
    void Reset( RESET_REASON aReason ) override;

    ///< Upload the current project and copy a share link to the clipboard.
    int StartSession( const TOOL_EVENT& aEvent );

    ///< Join a project from a pasted share link.
    int JoinSession( const TOOL_EVENT& aEvent );

    ///< Leave the session and remove all remote cursors.
    int LeaveSession( const TOOL_EVENT& aEvent );

    ///< True while this frame is connected to a collaboration session.
    bool sessionActive() const { return !m_pathByDocId.empty(); }

    // COLLAB_DOC_ADAPTER; all calls arrive on the UI thread.
    void OnPresenceChanged() override;
    void OnSessionStateChanged() override;
    void OnRemoteOp( const nlohmann::json& aOpMsg ) override;
    void OnOpsTail( const nlohmann::json& aOpsMsg ) override;
    void OnSnapshot( const nlohmann::json& aSnapshotMsg ) override;
    void OnAck( const wxString& aClientOpId, long long aSeq ) override;
    void OnOpRejected( const wxString& aClientOpId, const wxString& aCode ) override;
    void OnComment( const nlohmann::json& aMsg ) override;

    ///< Toggle the version-history sidebar pane.
    int ShowHistory( const TOOL_EVENT& aEvent );
    void OnSnapshotRequest() override;
    void OnReset( const wxString& aDocId, long long aSeq ) override;

    ///< The live-editing sync engine, or nullptr when no session is active.
    SCH_COLLAB_SYNC* GetSync() const { return m_sync.get(); }

private:
    ///< Set up handlers for various events.
    void setTransitions() override;

    ///< Selection events only mark presence dirty; the timer tick throttles the send.
    int onSelectionChange( const TOOL_EVENT& aEvent );

    ///< 100 ms presence tick: send our state when it changed since the last tick.
    void onTimer( wxTimerEvent& aEvent );

    ///< Run aContinuation with a bearer token, signing in interactively if needed.
    void withSignIn( std::function<void( const wxString& aToken )> aContinuation );

    void joinWithToken( const wxString& aToken, const wxString& aLinkToken );
    void startWithToken( const wxString& aToken );

    ///< Connect and join every schematic doc of aProject (a server project json).
    ///< With aConnect false the process-wide session is reused rather than
    ///< (re)connected — for joining docs of a session another editor owns.
    void beginSession( const nlohmann::json& aProject, const wxString& aToken,
                       const wxString& aLinkToken, bool aConnect = true );
    void endSession();

    ///< Rejoin the live session recorded beside a cloud project copy (link.json),
    ///< silently.  No-op without a stored token or link file.
    void tryAutoJoin();


    ///< The displayed screen's file name, relative to the project (forward slashes).
    wxString currentSheetFile() const;

    ///< The server doc id for the displayed screen, or empty.
    wxString currentDocId() const;

    ///< Rebuild the remote-cursor overlay from the current peers and repaint.
    void rebuildOverlay();

private:
    COLLAB_AUTH        m_auth;
    wxTimer            m_timer;
    COLLAB_CURSOR_ITEM m_cursorItem;

    std::unique_ptr<SCH_COLLAB_SYNC> m_sync;      ///< live while a session is active

    std::map<wxString, wxString> m_docIdByPath;   ///< project-relative path -> server doc id

    ///< docId -> that doc's comments (REST shape), fetched on join and kept
    ///< fresh by live `comment` broadcasts.
    std::map<wxString, nlohmann::json> m_commentsByDoc;

    ///< Guards async comment-fetch completions against tool teardown.
    std::shared_ptr<bool> m_alive = std::make_shared<bool>( true );

    ///< Fetch every joined doc's comments off-thread.
    void fetchComments();

    ///< The version-history sidebar pane (created lazily; owned by AUI).
    class COLLAB_HISTORY_PANEL* m_historyPanel = nullptr;

    ///< Create the pane if needed; bind it to the current project.
    class COLLAB_HISTORY_PANEL* historyPanel();

    ///< Rebuild the overlay's comment pins for the displayed sheet.
    void rebuildCommentPins();
    std::map<wxString, wxString> m_pathByDocId;

    nlohmann::json m_lastSentState;
    wxString       m_lastSentDocId;
    wxString       m_lastSheetFile;
    wxDateTime     m_lastPresenceSend;  ///< for the idle keepalive
    wxDateTime     m_lastRejectNotice;  ///< throttles the rejected-edit infobar
    bool           m_presenceDirty;
    wxString       m_autoJoinProject;   ///< project path an auto-join was attempted for
};
