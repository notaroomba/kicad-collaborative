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

#include <collab/collab_session.h>

#include <collab/collab_ws_client.h>
#include <kiid.h>

#include <wx/log.h>
#include <wx/utils.h>

// Marshal WS-thread callbacks onto the UI thread (KICAD_API_SERVER pattern).
wxDEFINE_EVENT( COLLAB_WS_CONNECTED_EVENT, wxCommandEvent );
wxDEFINE_EVENT( COLLAB_WS_DISCONNECTED_EVENT, wxCommandEvent );
wxDEFINE_EVENT( COLLAB_WS_MESSAGE_EVENT, wxCommandEvent );

static const wxChar* const traceCollab = wxT( "COLLAB" );

static const char* DEFAULT_SERVER = "https://kicad-collab-production.up.railway.app";


COLLAB_SESSION* COLLAB_SESSION::s_instance = nullptr;


COLLAB_SESSION& COLLAB_SESSION::Get()
{
    // Deliberately leaked: destroying a wxEvtHandler during static teardown is
    // unsafe. Shutdown() below does the part that actually matters.
    if( !s_instance )
        s_instance = new COLLAB_SESSION();

    return *s_instance;
}


void COLLAB_SESSION::Shutdown()
{
    if( !s_instance )
        return;

    // Join the worker before curl global cleanup: a task mid-request holds
    // curl state that must not outlive it.
    {
        std::unique_lock<std::mutex> lock( s_instance->m_workMutex );
        s_instance->m_workStop = true;
    }

    s_instance->m_workCv.notify_all();

    if( s_instance->m_worker.joinable() )
        s_instance->m_worker.join();

    s_instance->Disconnect();
}


void COLLAB_SESSION::RunAsync( std::function<void()> aTask )
{
    std::unique_lock<std::mutex> lock( m_workMutex );

    if( m_workStop )
        return;     // shutting down: drop the task

    m_workQueue.push_back( std::move( aTask ) );

    if( !m_worker.joinable() )
    {
        m_worker = std::thread(
                [this]()
                {
                    for( ;; )
                    {
                        std::function<void()> task;

                        {
                            std::unique_lock<std::mutex> workLock( m_workMutex );

                            m_workCv.wait( workLock,
                                           [this]()
                                           {
                                               return m_workStop || !m_workQueue.empty();
                                           } );

                            if( m_workStop && m_workQueue.empty() )
                                return;

                            task = std::move( m_workQueue.front() );
                            m_workQueue.pop_front();
                        }

                        try
                        {
                            task();
                        }
                        catch( ... )
                        {
                            // A background task must never take the app down.
                        }
                    }
                } );
    }

    lock.unlock();
    m_workCv.notify_one();
}


wxString COLLAB_SESSION::ServerUrl()
{
    wxString url;

    if( !wxGetEnv( wxS( "KICAD_COLLAB_SERVER" ), &url ) || url.IsEmpty() )
        url = wxString::FromUTF8( DEFAULT_SERVER );

    while( url.EndsWith( wxS( "/" ) ) )
        url.RemoveLast();

    return url;
}


COLLAB_SESSION::COLLAB_SESSION()
{
    // Stable per-process client id: the op-dedup key on the server.
    m_clientId = wxS( "c-" ) + KIID().AsString();

    Bind( COLLAB_WS_CONNECTED_EVENT, &COLLAB_SESSION::onWsConnected, this );
    Bind( COLLAB_WS_DISCONNECTED_EVENT, &COLLAB_SESSION::onWsDisconnected, this );
    Bind( COLLAB_WS_MESSAGE_EVENT, &COLLAB_SESSION::onWsMessage, this );
}


COLLAB_SESSION::~COLLAB_SESSION()
{
    Disconnect();
}


void COLLAB_SESSION::setState( STATE aState )
{
    if( m_state == aState )
        return;

    m_state = aState;

    for( auto& [docId, doc] : m_docs )
    {
        if( doc.adapter )
            doc.adapter->OnSessionStateChanged();
    }
}


void COLLAB_SESSION::Connect( const wxString& aToken, const wxString& aLinkToken )
{
    Disconnect();

    // A libcurl without ws/wss (e.g. the macOS system one) would otherwise fail
    // inside the reconnect loop forever with no diagnostic.
    if( !COLLAB_WS_CLIENT::IsSupported() )
    {
        wxLogWarning( wxS( "Collaboration is unavailable: this libcurl was built without "
                           "WebSocket support." ) );
        setState( STATE::DISCONNECTED );
        return;
    }

    m_generation++;
    m_token = aToken;
    m_linkToken = aLinkToken;

    wxString wsUrl = ServerUrl();

    if( wsUrl.StartsWith( wxS( "https://" ) ) )
        wsUrl.Replace( wxS( "https://" ), wxS( "wss://" ), false );
    else if( wsUrl.StartsWith( wxS( "http://" ) ) )
        wsUrl.Replace( wxS( "http://" ), wxS( "ws://" ), false );

    wsUrl << wxS( "/ws" );

    setState( STATE::CONNECTING );

    m_ws = std::make_unique<COLLAB_WS_CLIENT>();

    COLLAB_WS_CLIENT::CALLBACKS callbacks;

    // All three fire on the WS thread; hand off to the UI thread immediately.
    callbacks.onConnected = [this]()
    {
        wxQueueEvent( this, new wxCommandEvent( COLLAB_WS_CONNECTED_EVENT ) );
    };
    callbacks.onDisconnected = [this]()
    {
        wxQueueEvent( this, new wxCommandEvent( COLLAB_WS_DISCONNECTED_EVENT ) );
    };
    const long generation = m_generation;

    callbacks.onMessage = [this, generation]( std::string&& aMsg )
    {
        wxCommandEvent* evt = new wxCommandEvent( COLLAB_WS_MESSAGE_EVENT );
        evt->SetClientData( new std::string( std::move( aMsg ) ) );
        evt->SetExtraLong( generation );
        wxQueueEvent( this, evt );
    };

    m_ws->Start( wsUrl.ToStdString( wxConvUTF8 ), std::move( callbacks ) );
}


void COLLAB_SESSION::Disconnect()
{
    if( m_ws )
    {
        m_ws->Stop();
        m_ws.reset();
    }

    // Any event still queued from the connection we just stopped is stale.
    m_generation++;

    for( auto& [docId, doc] : m_docs )
        doc.peers.clear();

    setState( STATE::DISCONNECTED );
}


void COLLAB_SESSION::ForgetAdapter( COLLAB_DOC_ADAPTER* aAdapter )
{
    for( auto it = m_docs.begin(); it != m_docs.end(); )
    {
        if( it->second.adapter == aAdapter )
        {
            if( m_state == STATE::LIVE )
            {
                sendJson( {
                    { "type", "leave_doc" },
                    { "docId", it->first.ToStdString( wxConvUTF8 ) },
                } );
            }

            it = m_docs.erase( it );
        }
        else
        {
            ++it;
        }
    }
}


void COLLAB_SESSION::SetAppliedSeq( const wxString& aDocId, long long aSeq )
{
    if( auto it = m_docs.find( aDocId ); it != m_docs.end() )
        it->second.sinceSeq = aSeq;
}


void COLLAB_SESSION::sendJson( const nlohmann::json& aMsg )
{
    if( m_ws )
        m_ws->Send( aMsg.dump() );
}


void COLLAB_SESSION::onWsConnected( wxCommandEvent& )
{
    wxLogTrace( traceCollab, wxS( "ws connected; sending hello" ) );

    nlohmann::json hello = {
        { "type", "hello" },
        { "proto", 1 },
        { "token", m_token.ToStdString( wxConvUTF8 ) },
        { "clientId", m_clientId.ToStdString( wxConvUTF8 ) },
        { "client", "kicad-collab/0.1" },
    };

    if( !m_linkToken.IsEmpty() )
        hello[ "linkToken" ] = m_linkToken.ToStdString( wxConvUTF8 );

    sendJson( hello );
}


void COLLAB_SESSION::onWsDisconnected( wxCommandEvent& )
{
    wxLogTrace( traceCollab, wxS( "ws disconnected" ) );

    for( auto& [docId, doc] : m_docs )
    {
        doc.peers.clear();

        if( doc.adapter )
            doc.adapter->OnPresenceChanged();
    }

    // The WS client keeps reconnecting on its own unless we asked to stop.
    if( m_ws )
        setState( STATE::CONNECTING );
    else
        setState( STATE::DISCONNECTED );
}


void COLLAB_SESSION::onWsMessage( wxCommandEvent& aEvent )
{
    // unique_ptr regardless of generation: the payload must be freed even when
    // the message itself is stale.
    std::unique_ptr<std::string> payload(
            static_cast<std::string*>( aEvent.GetClientData() ) );

    if( !payload || aEvent.GetExtraLong() != m_generation )
        return;

    try
    {
        routeMessage( nlohmann::json::parse( *payload ) );
    }
    catch( const std::exception& e )
    {
        wxLogTrace( traceCollab, wxS( "bad server message: %s" ), e.what() );
    }
}


/// Monotonic: out-of-order delivery must never rewind our catch-up point.
static void advanceSince( std::optional<long long>& aSince, long long aSeq )
{
    if( aSeq > 0 && ( !aSince || aSeq > *aSince ) )
        aSince = aSeq;
}


static COLLAB_PEER peerFromJson( const nlohmann::json& aPeer )
{
    COLLAB_PEER peer;
    peer.clientId = wxString::FromUTF8( aPeer.value( "clientId", "" ) );
    peer.userId = aPeer.value( "userId", 0LL );
    peer.login = wxString::FromUTF8( aPeer.value( "login", "" ) );
    peer.name = wxString::FromUTF8( aPeer.value( "name", "" ) );
    peer.color = wxString::FromUTF8( aPeer.value( "color", "#4477ee" ) );

    if( peer.name.IsEmpty() )
        peer.name = peer.login;

    return peer;
}


void COLLAB_SESSION::routeMessage( const nlohmann::json& aMsg )
{
    const std::string type = aMsg.value( "type", "" );

    if( type == "hello_ok" )
    {
        m_disconnectReason.clear();
        // The server namespaces our client id by user id; adopt the echoed
        // value or we fail to recognise our own presence and every user sees a
        // ghost of their own cursor.
        if( aMsg.contains( "clientId" ) )
        {
            wxString assigned = wxString::FromUTF8( aMsg.value( "clientId", "" ) );

            if( !assigned.IsEmpty() )
                m_clientId = assigned;
        }

        m_selfColor = wxString::FromUTF8( aMsg.value( "color", "#4477ee" ) );
        m_selfLogin = wxString::FromUTF8( aMsg.value( "login", "" ) );

        setState( STATE::LIVE );

        // (Re)join every registered doc — covers both initial connect and
        // automatic reconnect.
        for( auto& [docId, doc] : m_docs )
        {
            nlohmann::json join = {
                { "type", "join_doc" },
                { "docId", docId.ToStdString( wxConvUTF8 ) },
            };

            if( doc.sinceSeq )
                join[ "sinceSeq" ] = *doc.sinceSeq;

            sendJson( join );
        }

        return;
    }

    const wxString docId = wxString::FromUTF8( aMsg.value( "docId", "" ) );
    auto docIt = m_docs.find( docId );

    if( type == "error" )
    {
        const std::string code = aMsg.value( "code", "" );

        wxLogTrace( traceCollab, wxS( "server error: %s" ), wxString::FromUTF8( aMsg.dump() ) );

        // Connection-level failures carry no docId and are not retryable:
        // reconnecting with the same dead token would loop forever.
        if( code == "auth_failed" || code == "unsupported_protocol" )
        {
            m_disconnectReason = wxString::FromUTF8( code );
            Disconnect();
            return;
        }

        if( docIt == m_docs.end() )
            return;

        // We fell behind the server's broadcast queue; ask for a fresh base.
        if( code == "desynced" || code == "doc_reset" )
        {
            RequestResync( docId );
            return;
        }

        if( docIt->second.adapter && aMsg.contains( "clientOpId" ) )
        {
            docIt->second.adapter->OnOpRejected(
                    wxString::FromUTF8( aMsg.value( "clientOpId", "" ) ),
                    wxString::FromUTF8( code ) );
        }

        return;
    }

    if( docIt == m_docs.end() )
        return;

    JOINED_DOC& doc = docIt->second;
    COLLAB_DOC_ADAPTER* adapter = doc.adapter;

    if( type == "doc_info" )
    {
        doc.peers.clear();

        if( aMsg.contains( "peers" ) && aMsg[ "peers" ].is_array() )
        {
            for( const nlohmann::json& p : aMsg[ "peers" ] )
            {
                COLLAB_PEER peer = peerFromJson( p );

                if( peer.clientId != m_clientId )
                    doc.peers.emplace( peer.clientId, peer );
            }
        }

        if( adapter )
        {
            adapter->OnDocInfo( aMsg );
            adapter->OnPresenceChanged();
        }
    }
    else if( type == "presence" )
    {
        if( aMsg.contains( "peers" ) && aMsg[ "peers" ].is_object() )
        {
            for( auto& [clientIdStr, entry] : aMsg[ "peers" ].items() )
            {
                wxString clientId = wxString::FromUTF8( clientIdStr );

                if( clientId == m_clientId )
                    continue;

                if( entry.is_null() )
                {
                    if( auto it = doc.peers.find( clientId ); it != doc.peers.end() )
                        it->second.state = nlohmann::json();
                }
                else
                {
                    COLLAB_PEER peer = peerFromJson( entry.value( "user", nlohmann::json::object() ) );
                    peer.clientId = clientId;
                    peer.state = entry.value( "state", nlohmann::json() );

                    auto [it, inserted] = doc.peers.emplace( clientId, peer );

                    if( !inserted )
                        it->second.state = peer.state;
                }
            }
        }

        if( adapter )
            adapter->OnPresenceChanged();
    }
    else if( type == "peer_joined" )
    {
        COLLAB_PEER peer = peerFromJson( aMsg.value( "peer", nlohmann::json::object() ) );

        if( peer.clientId != m_clientId )
        {
            doc.peers.emplace( peer.clientId, peer );

            if( adapter )
            {
                adapter->OnPeerJoined( peer );
                adapter->OnPresenceChanged();
            }
        }
    }
    else if( type == "peer_left" )
    {
        wxString clientId = wxString::FromUTF8( aMsg.value( "clientId", "" ) );
        doc.peers.erase( clientId );

        if( adapter )
        {
            adapter->OnPeerLeft( clientId );
            adapter->OnPresenceChanged();
        }
    }
    // Note: sinceSeq is advanced by the adapter through SetAppliedSeq() once an
    // op is really applied — not on arrival. An adapter that queues work would
    // otherwise claim a position it hasn't reached and skip ops on reconnect.
    // With no adapter there is no local state to keep, so arrival is enough.
    else if( type == "op" )
    {
        if( adapter )
            adapter->OnRemoteOp( aMsg );
        else
            advanceSince( doc.sinceSeq, aMsg.value( "seq", 0LL ) );
    }
    else if( type == "ops" )
    {
        if( adapter )
        {
            adapter->OnOpsTail( aMsg );
        }
        else if( aMsg.contains( "ops" ) && aMsg[ "ops" ].is_array() && !aMsg[ "ops" ].empty() )
        {
            advanceSince( doc.sinceSeq, aMsg[ "ops" ].back().value( "seq", 0LL ) );
        }
    }
    else if( type == "snapshot" )
    {
        if( adapter )
            adapter->OnSnapshot( aMsg );
        else
            advanceSince( doc.sinceSeq, aMsg.value( "seq", 0LL ) );
    }
    else if( type == "ack" )
    {
        if( adapter )
        {
            adapter->OnAck( wxString::FromUTF8( aMsg.value( "clientOpId", "" ) ),
                            aMsg.value( "seq", 0LL ) );
        }
    }
    else if( type == "snapshot_request" )
    {
        if( adapter )
            adapter->OnSnapshotRequest();
    }
    else if( type == "reset" )
    {
        if( adapter )
            adapter->OnReset( docId, aMsg.value( "seq", 0LL ) );
    }
}


void COLLAB_SESSION::JoinDoc( const wxString& aDocId, std::optional<long long> aSinceSeq,
                              COLLAB_DOC_ADAPTER* aAdapter )
{
    JOINED_DOC& doc = m_docs[ aDocId ];
    doc.adapter = aAdapter;
    doc.sinceSeq = aSinceSeq;

    if( m_state == STATE::LIVE )
    {
        nlohmann::json join = {
            { "type", "join_doc" },
            { "docId", aDocId.ToStdString( wxConvUTF8 ) },
        };

        if( aSinceSeq )
            join[ "sinceSeq" ] = *aSinceSeq;

        sendJson( join );
    }
}


void COLLAB_SESSION::LeaveDoc( const wxString& aDocId )
{
    if( m_state == STATE::LIVE )
    {
        sendJson( {
            { "type", "leave_doc" },
            { "docId", aDocId.ToStdString( wxConvUTF8 ) },
        } );
    }

    m_docs.erase( aDocId );
}


void COLLAB_SESSION::SendPresence( const wxString& aDocId, const nlohmann::json& aState )
{
    if( m_state != STATE::LIVE )
        return;

    sendJson( {
        { "type", "presence" },
        { "docId", aDocId.ToStdString( wxConvUTF8 ) },
        { "state", aState },
    } );
}


void COLLAB_SESSION::SendOp( const wxString& aDocId, const wxString& aClientOpId,
                             std::optional<long long> aBaseSeq, const nlohmann::json& aChanges )
{
    if( m_state != STATE::LIVE )
        return;

    nlohmann::json op = {
        { "type", "op" },
        { "docId", aDocId.ToStdString( wxConvUTF8 ) },
        { "clientOpId", aClientOpId.ToStdString( wxConvUTF8 ) },
        { "changes", aChanges },
    };

    if( aBaseSeq )
        op[ "baseSeq" ] = *aBaseSeq;

    sendJson( op );
}


void COLLAB_SESSION::RequestResync( const wxString& aDocId )
{
    if( m_state != STATE::LIVE )
        return;

    sendJson( {
        { "type", "resync" },
        { "docId", aDocId.ToStdString( wxConvUTF8 ) },
    } );
}


const std::map<wxString, COLLAB_PEER>& COLLAB_SESSION::Peers( const wxString& aDocId ) const
{
    static const std::map<wxString, COLLAB_PEER> empty;

    auto it = m_docs.find( aDocId );
    return it == m_docs.end() ? empty : it->second.peers;
}
