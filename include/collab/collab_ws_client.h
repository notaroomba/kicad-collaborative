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

#include <atomic>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <thread>

#include <kicommon.h>

/**
 * WebSocket client for the collaboration server.
 *
 * Uses libcurl's WebSocket API where the linked libcurl has one.  Many do not
 * (Apple's system libcurl, Ubuntu's up to at least 24.04), so otherwise it lets
 * libcurl open the connection, TLS and proxies included, and speaks the WebSocket
 * protocol (RFC 6455) over it itself.
 *
 * Owns one background thread that connects, pumps frames, and reconnects with
 * exponential backoff until Stop() is called.  All callbacks fire on the
 * background thread — marshal to the UI thread yourself (COLLAB_SESSION does
 * this with wxQueueEvent, mirroring KICAD_API_SERVER).
 */
class KICOMMON_API COLLAB_WS_CLIENT
{
public:
    struct CALLBACKS
    {
        std::function<void()>                onConnected;
        std::function<void()>                onDisconnected;
        std::function<void( std::string&& )> onMessage;
    };

    COLLAB_WS_CLIENT();
    ~COLLAB_WS_CLIENT();

    /// Always true: a libcurl without WebSocket support is covered by our own framing.
    static bool IsSupported();

    /// True if the linked libcurl was built with WebSocket support.
    static bool CurlHasWebSockets();

    /// Start the background thread against aWsUrl (ws:// or wss://).
    void Start( const std::string& aWsUrl, CALLBACKS aCallbacks );

    /// Stop the thread and close the connection. Safe to call twice.
    void Stop();

    bool IsConnected() const { return m_connected.load( std::memory_order_acquire ); }

    /// Queue a text frame for sending; drops silently when not connected.
    void Send( std::string aTextFrame );

private:
    void threadMain();
    /// One connect + pump cycle; returns when the connection dies or Stop().
    void runConnection();
    /// The same over a plain libcurl connection, with our own handshake and framing.
    void runOwnFraming();

    std::string             m_url;
    CALLBACKS               m_cb;
    std::thread             m_thread;
    std::atomic<bool>       m_running{ false };
    std::atomic<bool>       m_connected{ false };
    std::mutex              m_outMutex;
    std::deque<std::string> m_outbox;
};
