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

// kicad_curl.h must come before wx headers (winsock ordering on Windows).
#include <kicad_curl/kicad_curl.h>
#include <kicad_curl/kicad_curl_easy.h>
#include <curl/curl.h>

#include <collab/collab_ws_client.h>

#include <chrono>
#include <cstring>

#include <wx/log.h>

using namespace std::chrono_literals;

static constexpr int    POLL_MS = 50;
static constexpr long   CONNECT_TIMEOUT_SECS = 10;
static constexpr int    BACKOFF_START_MS = 1000;
static constexpr int    BACKOFF_MAX_MS = 30000;
static constexpr size_t OUTBOX_LIMIT = 1000;


COLLAB_WS_CLIENT::COLLAB_WS_CLIENT() = default;


COLLAB_WS_CLIENT::~COLLAB_WS_CLIENT()
{
    Stop();
}


bool COLLAB_WS_CLIENT::IsSupported()
{
    curl_version_info_data* info = curl_version_info( CURLVERSION_NOW );

    for( const char* const* proto = info->protocols; proto && *proto; ++proto )
    {
        if( strcmp( *proto, "ws" ) == 0 || strcmp( *proto, "wss" ) == 0 )
            return true;
    }

    return false;
}


void COLLAB_WS_CLIENT::Start( const std::string& aWsUrl, CALLBACKS aCallbacks )
{
    Stop();

    m_url = aWsUrl;
    m_cb = std::move( aCallbacks );
    m_running.store( true, std::memory_order_release );
    m_thread = std::thread( &COLLAB_WS_CLIENT::threadMain, this );
}


void COLLAB_WS_CLIENT::Stop()
{
    m_running.store( false, std::memory_order_release );

    if( m_thread.joinable() )
        m_thread.join();

    m_connected.store( false, std::memory_order_release );

    std::lock_guard<std::mutex> lock( m_outMutex );
    m_outbox.clear();
}


void COLLAB_WS_CLIENT::Send( std::string aTextFrame )
{
    std::lock_guard<std::mutex> lock( m_outMutex );

    // Bounded so a dead connection can't grow the queue without limit. Drop the
    // NEWEST frame: the oldest are the ops we still owe the server, while the
    // newest are usually presence updates that the next tick supersedes.
    if( m_outbox.size() >= OUTBOX_LIMIT )
        return;

    m_outbox.push_back( std::move( aTextFrame ) );
}


void COLLAB_WS_CLIENT::threadMain()
{
    int backoffMs = BACKOFF_START_MS;

    while( m_running.load( std::memory_order_acquire ) )
    {
        auto connectStart = std::chrono::steady_clock::now();

        // An exception escaping a std::thread is std::terminate; the callbacks
        // run user code (JSON, wx event posting) so this is not hypothetical.
        try
        {
            runConnection();
        }
        catch( const std::exception& e )
        {
            m_connected.store( false, std::memory_order_release );
            wxLogTrace( wxT( "COLLAB" ), wxS( "ws connection threw: %s" ), e.what() );
        }
        catch( ... )
        {
            m_connected.store( false, std::memory_order_release );
        }

        if( !m_running.load( std::memory_order_acquire ) )
            break;

        // A connection that lived a while resets the backoff.
        if( std::chrono::steady_clock::now() - connectStart > 30s )
            backoffMs = BACKOFF_START_MS;

        for( int waited = 0; waited < backoffMs && m_running.load( std::memory_order_acquire );
             waited += POLL_MS )
        {
            std::this_thread::sleep_for( std::chrono::milliseconds( POLL_MS ) );
        }

        backoffMs = std::min( backoffMs * 2, BACKOFF_MAX_MS );
    }
}


enum class WAIT_FOR
{
    READ,
    WRITE
};


static void waitOnSocket( curl_socket_t aSocket, int aTimeoutMs, WAIT_FOR aDirection )
{
    if( aSocket == CURL_SOCKET_BAD )
    {
        std::this_thread::sleep_for( std::chrono::milliseconds( aTimeoutMs ) );
        return;
    }

    timeval tv;
    tv.tv_sec = aTimeoutMs / 1000;
    tv.tv_usec = ( aTimeoutMs % 1000 ) * 1000;

    fd_set fds;
    FD_ZERO( &fds );
    FD_SET( aSocket, &fds );

    // Waiting for the wrong direction spins at 100% CPU: a socket with unread
    // data is always read-ready, so a send that returned CURLE_AGAIN would
    // return immediately, forever.
    select( static_cast<int>( aSocket ) + 1,
            aDirection == WAIT_FOR::READ ? &fds : nullptr,
            aDirection == WAIT_FOR::WRITE ? &fds : nullptr, nullptr, &tv );
}


void COLLAB_WS_CLIENT::runConnection()
{
    // KICAD_CURL_EASY handles global curl init/shutdown interlock; we drive
    // the raw handle for the WebSocket bits it has no wrapper for.
    KICAD_CURL_EASY easy;
    CURL*           curl = easy.GetCurl();

    easy.SetURL( m_url );

    // KICAD_CURL_EASY's ctor locks the handle to "http,https". ws/wss are
    // distinct protocols in libcurl's allow-list, so without this every
    // connection fails with CURLE_UNSUPPORTED_PROTOCOL. Widen this handle only;
    // never relax the ctor's default, which guards every HTTP client in KiCad.
    curl_easy_setopt( curl, CURLOPT_PROTOCOLS_STR, "ws,wss" );

    curl_easy_setopt( curl, CURLOPT_CONNECT_ONLY, 2L );
    curl_easy_setopt( curl, CURLOPT_CONNECTTIMEOUT, CONNECT_TIMEOUT_SECS );

    // Lets Stop() abort a connect/handshake in flight; otherwise its join()
    // blocks the UI thread until the connect times out.
    easy.SetTransferCallback(
            [this]( size_t, size_t, size_t, size_t ) -> int
            {
                return m_running.load( std::memory_order_acquire ) ? 0 : 1;
            },
            0 );

    if( easy.Perform() != CURLE_OK )
        return;

    m_connected.store( true, std::memory_order_release );

    if( m_cb.onConnected )
        m_cb.onConnected();

    std::string partial;
    char        buf[ 65536 ];
    bool        alive = true;

    while( alive && m_running.load( std::memory_order_acquire ) )
    {
        // Drain the outbox first.
        std::deque<std::string> toSend;
        {
            std::lock_guard<std::mutex> lock( m_outMutex );
            toSend.swap( m_outbox );
        }

        for( std::string& frame : toSend )
        {
            size_t offset = 0;

            while( offset < frame.size() )
            {
                size_t   sent = 0;
                CURLcode rc = curl_ws_send( curl, frame.data() + offset, frame.size() - offset,
                                            &sent, 0,
                                            offset == 0 ? CURLWS_TEXT : ( CURLWS_TEXT | CURLWS_OFFSET ) );
                offset += sent;

                if( rc == CURLE_AGAIN )
                {
                    if( !m_running.load( std::memory_order_acquire ) )
                    {
                        alive = false;
                        break;
                    }

                    curl_socket_t sock = CURL_SOCKET_BAD;
                    curl_easy_getinfo( curl, CURLINFO_ACTIVESOCKET, &sock );
                    waitOnSocket( sock, POLL_MS, WAIT_FOR::WRITE );
                    continue;
                }

                if( rc != CURLE_OK )
                {
                    alive = false;
                    break;
                }
            }

            if( !alive )
                break;
        }

        if( !alive )
            break;

        // Receive whatever is pending.
        bool sawData = false;

        while( alive )
        {
            size_t                     rlen = 0;
            const struct curl_ws_frame* meta = nullptr;
            CURLcode rc = curl_ws_recv( curl, buf, sizeof( buf ), &rlen, &meta );

            if( rc == CURLE_AGAIN )
                break;

            if( rc != CURLE_OK || !meta )
            {
                alive = false;
                break;
            }

            sawData = true;

            if( meta->flags & CURLWS_CLOSE )
            {
                alive = false;
                break;
            }

            if( meta->flags & CURLWS_PING )
            {
                size_t ignored = 0;
                curl_ws_send( curl, buf, rlen, &ignored, 0, CURLWS_PONG );
                continue;
            }

            if( meta->flags & CURLWS_PONG )
                continue;

            if( ( meta->flags & CURLWS_TEXT ) || ( meta->flags & CURLWS_CONT ) )
            {
                partial.append( buf, rlen );

                if( meta->bytesleft == 0 && !( meta->flags & CURLWS_CONT ) )
                {
                    if( m_cb.onMessage )
                        m_cb.onMessage( std::move( partial ) );

                    partial.clear();
                }
                else if( meta->bytesleft == 0 )
                {
                    // Continuation fragment fully read; final fragment arrives
                    // with CURLWS_TEXT|no-CONT... keep accumulating.
                }
            }
        }

        if( !alive )
            break;

        if( !sawData )
        {
            bool outboxEmpty;
            {
                std::lock_guard<std::mutex> lock( m_outMutex );
                outboxEmpty = m_outbox.empty();
            }

            if( outboxEmpty )
            {
                curl_socket_t sock = CURL_SOCKET_BAD;
                curl_easy_getinfo( curl, CURLINFO_ACTIVESOCKET, &sock );
                waitOnSocket( sock, POLL_MS, WAIT_FOR::READ );
            }
        }
    }

    m_connected.store( false, std::memory_order_release );

    if( m_cb.onDisconnected )
        m_cb.onDisconnected();
}
