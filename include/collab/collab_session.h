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

#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <map>
#include <memory>
#include <optional>
#include <string>

#include <kicommon.h>
#include <nlohmann/json.hpp>
#include <wx/event.h>
#include <wx/string.h>

class COLLAB_WS_CLIENT;

/**
 * A remote participant in a shared document, with their latest ephemeral
 * presence state (cursor, selection, viewport, sheetPath) if any.
 */
struct KICOMMON_API COLLAB_PEER
{
    wxString       clientId;
    long long      userId = 0;
    wxString       login;
    wxString       name;
    wxString       color;
    nlohmann::json state;   ///< empty/null when the peer has no live presence
};

/**
 * Per-document listener interface: an editor frame's collab tool implements
 * this to receive remote activity. All calls happen on the UI thread.
 */
class KICOMMON_API COLLAB_DOC_ADAPTER
{
public:
    virtual ~COLLAB_DOC_ADAPTER() = default;

    virtual void OnDocInfo( const nlohmann::json& aDocInfo ) {}
    virtual void OnRemoteOp( const nlohmann::json& aOpMsg ) {}
    virtual void OnOpsTail( const nlohmann::json& aOpsMsg ) {}
    virtual void OnSnapshot( const nlohmann::json& aSnapshotMsg ) {}
    virtual void OnAck( const wxString& aClientOpId, long long aSeq ) {}
    /// The server refused an op (bad_op, permission_denied, internal, ...).
    virtual void OnOpRejected( const wxString& aClientOpId, const wxString& aCode ) {}
    virtual void OnPresenceChanged() {}
    virtual void OnPeerJoined( const COLLAB_PEER& aPeer ) {}
    virtual void OnPeerLeft( const wxString& aClientId ) {}
    /// The server wants a fresh snapshot of @p aDocId (it is chosen per doc, and a client
    /// joined to several must serve the one asked for, not whatever it is displaying).
    virtual void OnSnapshotRequest( const wxString& aDocId ) {}
    virtual void OnReset( const wxString& aDocId, long long aSeq ) {}
    /// The server refused to let us into this doc (access revoked, or the doc is gone).
    /// Nothing further will arrive for it and nothing we send for it will be accepted.
    virtual void OnJoinRefused( const wxString& aDocId, const wxString& aCode ) {}
    /// A comment thread changed (REST-driven; relayed live by the server).
    virtual void OnComment( const nlohmann::json& aMsg ) {}
    virtual void OnSessionStateChanged() {}
};

/**
 * Process-wide collaboration session: owns the WebSocket client, marshals its
 * background-thread callbacks onto the UI thread (the KICAD_API_SERVER
 * pattern), tracks presence per document, and routes messages to registered
 * COLLAB_DOC_ADAPTERs.
 */
class KICOMMON_API COLLAB_SESSION : public wxEvtHandler
{
public:
    enum class STATE
    {
        DISCONNECTED,
        CONNECTING,
        LIVE,
    };

    /// Lazily-created singleton; call only from the UI thread.
    static COLLAB_SESSION& Get();

    /**
     * Stop the WebSocket thread. Must run before KICAD_CURL::Cleanup(): the
     * pump loop holds a curl shared lock for the life of a connection, which
     * would block curl_global_cleanup() forever.
     */
    static void Shutdown();

    /// True if the singleton exists (so shutdown paths need not create one).
    static bool Exists() { return s_instance != nullptr; }

    /// The collab server base URL (KICAD_COLLAB_SERVER env var or built-in default).
    static wxString ServerUrl();

    /**
     * Run a blocking task (REST calls, mostly) on the session's worker thread
     * instead of the UI thread.  Tasks run in order.  Marshal any UI work back
     * with wxTheApp->CallAfter, guarded against the caller being destroyed.
     * The worker is joined in Shutdown(), before curl global cleanup.
     */
    void RunAsync( std::function<void()> aTask );

    STATE GetState() const { return m_state; }
    bool  IsLive() const { return m_state == STATE::LIVE; }

    /// Why the last transition to DISCONNECTED happened ("auth_failed",
    /// "unsupported_protocol", or empty for an ordinary drop/stop).
    const wxString& DisconnectReason() const { return m_disconnectReason; }

    /// Our server-assigned client id (stable for this process).
    const wxString& ClientId() const { return m_clientId; }
    const wxString& SelfColor() const { return m_selfColor; }
    /// Our server user id (0 until the hello handshake completes).
    long long       SelfUserId() const { return m_selfUserId; }
    const wxString& SelfLogin() const { return m_selfLogin; }

    /**
     * Connect to the server with a bearer token (see COLLAB_AUTH). Optionally
     * present a share-link token to claim access on connect.
     */
    void Connect( const wxString& aToken, const wxString& aLinkToken = wxEmptyString );
    void Disconnect();

    /**
     * One editor is done with the session: drop the connection, and with it the
     * session's identity, but only once no document is joined any more.
     *
     * The WebSocket is process-wide and shared — eeschema and pcbnew join their own
     * documents over the one connection — so an unconditional Disconnect() from
     * whichever editor the user happened to leave (or close) first killed the other
     * editor's live session under it, with nothing to tell that editor its docs had
     * gone: its File menu went on greying out Start/Join and offering Leave Session
     * while nothing synced.  Every caller must LeaveDoc() its own documents first.
     *
     * @return true when the session really was torn down (we were the last one out).
     */
    bool ReleaseIfIdle();

    /**
     * Join a server document and register its adapter. aSinceSeq is the last
     * seq the caller has applied (empty = cold join, server sends a snapshot).
     */
    void JoinDoc( const wxString& aDocId, std::optional<long long> aSinceSeq,
                  COLLAB_DOC_ADAPTER* aAdapter );
    void LeaveDoc( const wxString& aDocId );

    /**
     * Drop every reference to an adapter. Editor frames outlive nothing here —
     * the session is process-wide, so a tool that forgets to call this on
     * destruction leaves a dangling pointer behind.
     */
    void ForgetAdapter( COLLAB_DOC_ADAPTER* aAdapter );

    /// Last sequence number the caller has applied for a doc (drives catch-up).
    void SetAppliedSeq( const wxString& aDocId, long long aSeq );

    void SendPresence( const wxString& aDocId, const nlohmann::json& aState );

    /// Shrink a presence state in place until the server's 8 KB cap will take it; the server
    /// drops an oversized one outright, which silently freezes the sender's cursor for
    /// everyone.  Public for the tests.
    static void ClampPresence( nlohmann::json& aState );
    void SendOp( const wxString& aDocId, const wxString& aClientOpId,
                 std::optional<long long> aBaseSeq, const nlohmann::json& aChanges );
    void RequestResync( const wxString& aDocId );

    /// Remote peers of a document (never includes ourselves).
    const std::map<wxString, COLLAB_PEER>& Peers( const wxString& aDocId ) const;

    /**
     * The current project's docs array (from the server project json), so editors
     * other than the one that started the session can find their own doc ids.
     */
    /// The joined project's server id (set by whichever editor starts/joins).
    void SetProjectId( const wxString& aProjectId ) { m_projectId = aProjectId; }
    const wxString& ProjectId() const { return m_projectId; }

    void SetProjectDocs( const nlohmann::json& aDocs ) { m_projectDocs = aDocs; }
    const nlohmann::json& ProjectDocs() const { return m_projectDocs; }

    /// Test seams: feed a server message through the real router, observe what would go
    /// out on the socket, and force the connection state.  The QA suites drive the
    /// reconnect ordering rules with these; production code never calls them.
    void RouteMessageForTests( const nlohmann::json& aMsg ) { routeMessage( aMsg ); }
    void SetSendSinkForTests( std::function<void( const nlohmann::json& )> aSink ) { m_sendSink = std::move( aSink ); }
    void SetStateForTests( STATE aState ) { setState( aState ); }

private:
    COLLAB_SESSION();
    ~COLLAB_SESSION() override;

    void setState( STATE aState );
    void sendJson( const nlohmann::json& aMsg );
    void onWsConnected( wxCommandEvent& aEvent );
    void onWsDisconnected( wxCommandEvent& aEvent );
    void onWsMessage( wxCommandEvent& aEvent );
    void routeMessage( const nlohmann::json& aMsg );

    struct JOINED_DOC
    {
        COLLAB_DOC_ADAPTER*             adapter = nullptr;
        std::optional<long long>        sinceSeq;
        std::map<wxString, COLLAB_PEER> peers;
        /// False until doc_info lands, and again once the server refuses the join.  Sending
        /// ops for a doc the server has not accepted only fills the on-disk journal with
        /// edits that are refused again on every reconnect, forever.
        bool                            joined = false;
    };

    std::unique_ptr<COLLAB_WS_CLIENT> m_ws;
    std::function<void( const nlohmann::json& )> m_sendSink;   // tests only
    STATE                             m_state = STATE::DISCONNECTED;
    wxString                          m_disconnectReason;
    wxString                          m_projectId;

    std::thread                       m_worker;
    std::mutex                        m_workMutex;
    std::condition_variable           m_workCv;
    std::deque<std::function<void()>> m_workQueue;
    bool                              m_workStop = false;
    nlohmann::json                    m_projectDocs;
    wxString                          m_token;
    wxString                          m_linkToken;
    wxString                          m_clientId;
    wxString                          m_selfColor;
    wxString                          m_selfLogin;
    long long                         m_selfUserId = 0;
    std::map<wxString, JOINED_DOC>    m_docs;

    /// Bumped on every Connect/Disconnect so wx events queued by a torn-down
    /// connection are recognised as stale and their payloads freed.
    long                              m_generation = 0;

    static COLLAB_SESSION*            s_instance;
};
