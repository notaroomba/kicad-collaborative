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
#include <random>

#include <wx/base64.h>

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
    return true;
}


bool COLLAB_WS_CLIENT::CurlHasWebSockets()
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
            if( CurlHasWebSockets() )
                runConnection();
            else
                runOwnFraming();
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


// ---------------------------------------------------------------------------------------
// RFC 6455 over a connection libcurl opened, for a libcurl built without WebSockets.

namespace
{
enum WS_OPCODE
{
    WS_CONT = 0x0,
    WS_TEXT = 0x1,
    WS_BINARY = 0x2,
    WS_CLOSE = 0x8,
    WS_PING = 0x9,
    WS_PONG = 0xA
};


/// A client frame: always final, always masked (the protocol requires it of clients).
std::string buildFrame( int aOpcode, const char* aData, size_t aLen, std::mt19937& aRng )
{
    std::string frame;
    frame.reserve( aLen + 14 );
    frame.push_back( static_cast<char>( 0x80 | aOpcode ) );

    if( aLen < 126 )
    {
        frame.push_back( static_cast<char>( 0x80 | aLen ) );
    }
    else if( aLen <= 0xFFFF )
    {
        frame.push_back( static_cast<char>( 0x80 | 126 ) );
        frame.push_back( static_cast<char>( ( aLen >> 8 ) & 0xFF ) );
        frame.push_back( static_cast<char>( aLen & 0xFF ) );
    }
    else
    {
        frame.push_back( static_cast<char>( 0x80 | 127 ) );

        for( int shift = 56; shift >= 0; shift -= 8 )
            frame.push_back( static_cast<char>( ( static_cast<uint64_t>( aLen ) >> shift ) & 0xFF ) );
    }

    uint32_t      word = aRng();
    unsigned char mask[4] = { static_cast<unsigned char>( word ), static_cast<unsigned char>( word >> 8 ),
                              static_cast<unsigned char>( word >> 16 ),
                              static_cast<unsigned char>( word >> 24 ) };

    frame.append( reinterpret_cast<const char*>( mask ), 4 );

    size_t start = frame.size();
    frame.append( aData, aLen );

    for( size_t i = 0; i < aLen; ++i )
        frame[start + i] = static_cast<char>( static_cast<unsigned char>( frame[start + i] ) ^ mask[i % 4] );

    return frame;
}


std::string lowered( std::string aText )
{
    for( char& c : aText )
        c = static_cast<char>( tolower( static_cast<unsigned char>( c ) ) );

    return aText;
}
} // namespace


void COLLAB_WS_CLIENT::runOwnFraming()
{
    // Host and path for the upgrade request, from the URL as libcurl reads it.
    std::string url = m_url;

    if( url.compare( 0, 6, "wss://" ) == 0 )
        url = "https://" + url.substr( 6 );
    else if( url.compare( 0, 5, "ws://" ) == 0 )
        url = "http://" + url.substr( 5 );

    std::string host, path = "/";

    if( CURLU* parts = curl_url() )
    {
        if( curl_url_set( parts, CURLUPART_URL, url.c_str(), 0 ) == CURLUE_OK )
        {
            char* text = nullptr;

            if( curl_url_get( parts, CURLUPART_HOST, &text, 0 ) == CURLUE_OK && text )
            {
                host = text;
                curl_free( text );
            }

            text = nullptr;

            if( curl_url_get( parts, CURLUPART_PORT, &text, 0 ) == CURLUE_OK && text )
            {
                host += std::string( ":" ) + text;
                curl_free( text );
            }

            text = nullptr;

            if( curl_url_get( parts, CURLUPART_PATH, &text, 0 ) == CURLUE_OK && text )
            {
                path = text;
                curl_free( text );
            }

            text = nullptr;

            if( curl_url_get( parts, CURLUPART_QUERY, &text, 0 ) == CURLUE_OK && text )
            {
                path += std::string( "?" ) + text;
                curl_free( text );
            }
        }

        curl_url_cleanup( parts );
    }

    if( host.empty() )
        return;

    KICAD_CURL_EASY easy;
    CURL*           curl = easy.GetCurl();

    easy.SetURL( url );
    curl_easy_setopt( curl, CURLOPT_CONNECT_ONLY, 1L );
    curl_easy_setopt( curl, CURLOPT_CONNECTTIMEOUT, CONNECT_TIMEOUT_SECS );
    // The upgrade is an HTTP/1.1 exchange; keep TLS from negotiating HTTP/2.
    curl_easy_setopt( curl, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1 );

    easy.SetTransferCallback(
            [this]( size_t, size_t, size_t, size_t ) -> int
            {
                return m_running.load( std::memory_order_acquire ) ? 0 : 1;
            },
            0 );

    if( easy.Perform() != CURLE_OK )
        return;

    auto socketOf = [curl]() -> curl_socket_t
    {
        curl_socket_t sock = CURL_SOCKET_BAD;
        curl_easy_getinfo( curl, CURLINFO_ACTIVESOCKET, &sock );
        return sock;
    };

    // Everything goes out through here; false when the connection is gone or we are stopping.
    auto sendAll = [&]( const std::string& aBytes ) -> bool
    {
        size_t offset = 0;

        while( offset < aBytes.size() )
        {
            size_t   sent = 0;
            CURLcode rc = curl_easy_send( curl, aBytes.data() + offset, aBytes.size() - offset, &sent );
            offset += sent;

            if( rc == CURLE_AGAIN )
            {
                if( !m_running.load( std::memory_order_acquire ) )
                    return false;

                waitOnSocket( socketOf(), POLL_MS, WAIT_FOR::WRITE );
                continue;
            }

            if( rc != CURLE_OK )
                return false;
        }

        return true;
    };

    std::random_device seed;
    std::mt19937       rng( seed() );

    unsigned char nonce[16];

    for( unsigned char& b : nonce )
        b = static_cast<unsigned char>( rng() );

    std::string key = wxBase64Encode( nonce, sizeof( nonce ) ).ToStdString();

    std::string request = "GET " + path + " HTTP/1.1\r\n"
                          "Host: " + host + "\r\n"
                          "Upgrade: websocket\r\n"
                          "Connection: Upgrade\r\n"
                          "Sec-WebSocket-Key: " + key + "\r\n"
                          "Sec-WebSocket-Version: 13\r\n"
                          "\r\n";

    if( !sendAll( request ) )
        return;

    // The response headers, then whatever frames arrived on their heels.
    std::string inbox;
    char        buf[65536];
    auto        deadline = std::chrono::steady_clock::now() + std::chrono::seconds( CONNECT_TIMEOUT_SECS );
    size_t      headerEnd = std::string::npos;

    while( headerEnd == std::string::npos )
    {
        if( !m_running.load( std::memory_order_acquire ) || std::chrono::steady_clock::now() > deadline
            || inbox.size() > 65536 )
        {
            return;
        }

        size_t   got = 0;
        CURLcode rc = curl_easy_recv( curl, buf, sizeof( buf ), &got );

        if( rc == CURLE_AGAIN )
        {
            waitOnSocket( socketOf(), POLL_MS, WAIT_FOR::READ );
            continue;
        }

        if( rc != CURLE_OK || got == 0 )
            return;

        inbox.append( buf, got );
        headerEnd = inbox.find( "\r\n\r\n" );
    }

    std::string headers = lowered( inbox.substr( 0, headerEnd ) );
    inbox.erase( 0, headerEnd + 4 );

    if( headers.compare( 0, 12, "http/1.1 101" ) != 0 || headers.find( "upgrade: websocket" ) == std::string::npos )
    {
        wxLogTrace( wxT( "COLLAB" ), wxS( "ws upgrade refused: %s" ),
                    wxString::FromUTF8( headers.substr( 0, headers.find( "\r\n" ) ) ) );
        return;
    }

    m_connected.store( true, std::memory_order_release );

    if( m_cb.onConnected )
        m_cb.onConnected();

    std::string message;        // a text message being assembled from fragments
    bool        inMessage = false;
    bool        alive = true;

    while( alive && m_running.load( std::memory_order_acquire ) )
    {
        std::deque<std::string> toSend;
        {
            std::lock_guard<std::mutex> lock( m_outMutex );
            toSend.swap( m_outbox );
        }

        for( const std::string& text : toSend )
        {
            if( !sendAll( buildFrame( WS_TEXT, text.data(), text.size(), rng ) ) )
            {
                alive = false;
                break;
            }
        }

        if( !alive )
            break;

        bool sawData = false;

        while( alive )
        {
            size_t   got = 0;
            CURLcode rc = curl_easy_recv( curl, buf, sizeof( buf ), &got );

            if( rc == CURLE_AGAIN )
                break;

            if( rc != CURLE_OK || got == 0 )
            {
                alive = false;
                break;
            }

            sawData = true;
            inbox.append( buf, got );
        }

        // Take every whole frame out of what has arrived.
        size_t at = 0;

        while( alive )
        {
            size_t have = inbox.size() - at;

            if( have < 2 )
                break;

            const unsigned char* p = reinterpret_cast<const unsigned char*>( inbox.data() ) + at;
            bool                 fin = p[0] & 0x80;
            int                  opcode = p[0] & 0x0F;
            bool                 masked = p[1] & 0x80;
            uint64_t             len = p[1] & 0x7F;
            size_t               head = 2;

            if( len == 126 )
            {
                if( have < 4 )
                    break;

                len = ( static_cast<uint64_t>( p[2] ) << 8 ) | p[3];
                head = 4;
            }
            else if( len == 127 )
            {
                if( have < 10 )
                    break;

                len = 0;

                for( int i = 0; i < 8; ++i )
                    len = ( len << 8 ) | p[2 + i];

                head = 10;
            }

            // A server never masks, and nothing we expect is anywhere near this large.
            if( masked || len > ( 256u << 20 ) )
            {
                alive = false;
                break;
            }

            if( have < head + len )
                break;

            const char* payload = inbox.data() + at + head;
            at += head + static_cast<size_t>( len );

            switch( opcode )
            {
            case WS_TEXT:
            case WS_BINARY:
                message.assign( payload, static_cast<size_t>( len ) );
                inMessage = !fin;

                if( fin && opcode == WS_TEXT && m_cb.onMessage )
                    m_cb.onMessage( std::move( message ) );

                if( fin )
                    message.clear();

                break;

            case WS_CONT:
                if( inMessage )
                {
                    message.append( payload, static_cast<size_t>( len ) );

                    if( fin )
                    {
                        inMessage = false;

                        if( m_cb.onMessage )
                            m_cb.onMessage( std::move( message ) );

                        message.clear();
                    }
                }

                break;

            case WS_PING:
                if( !sendAll( buildFrame( WS_PONG, payload, static_cast<size_t>( len ), rng ) ) )
                    alive = false;

                break;

            case WS_PONG:
                break;

            case WS_CLOSE:
                sendAll( buildFrame( WS_CLOSE, payload, std::min<size_t>( static_cast<size_t>( len ), 2 ), rng ) );
                alive = false;
                break;

            default:
                alive = false;
                break;
            }
        }

        if( at > 0 )
            inbox.erase( 0, at );

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
                waitOnSocket( socketOf(), POLL_MS, WAIT_FOR::READ );
        }
    }

    if( m_running.load( std::memory_order_acquire ) == false && alive )
        sendAll( buildFrame( WS_CLOSE, "\x03\xe8", 2, rng ) );

    m_connected.store( false, std::memory_order_release );

    if( m_cb.onDisconnected )
        m_cb.onDisconnected();
}
