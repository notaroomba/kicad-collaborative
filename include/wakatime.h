/*
 * This program source code file is part of Junction, a KiCad fork.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef WAKATIME_H
#define WAKATIME_H

#include <kicommon.h>
#include <wx/string.h>
#include <atomic>
#include <mutex>

class EDA_BASE_FRAME;

/**
 * WakaTime heartbeats for the desktop editors, the way WakaTime's editor plugins send them.
 *
 * The tool dispatcher reports every mouse and keyboard event on a canvas (Activity with
 * aIsWrite false) and EDA_BASE_FRAME::OnModify every edit (aIsWrite true).  A heartbeat goes
 * out when the file changes, when two minutes have passed since the last one, or on the first
 * edit after a heartbeat that was only looking.
 *
 * Like every WakaTime plugin it reads the key and server from ~/.wakatime.cfg ([settings]
 * api_key, api_url; $WAKATIME_HOME moves it), so WakaTime, Hackatime, Wakapi or any other
 * server speaking the WakaTime API all work.  It hands the heartbeat to wakatime-cli when the
 * CLI is installed (~/.wakatime/wakatime-cli*, or on the PATH), which also queues heartbeats
 * while offline; without the CLI it posts the heartbeat itself on a worker thread.
 *
 * Preferences → Common → WakaTime (PANEL_WAKATIME) edits the same file; whether Junction sends
 * heartbeats at all is kept there too, in a [junction] section other plugins ignore.
 */
class KICOMMON_API WAKATIME
{
public:
    static WAKATIME& Get();

    /// Something happened in a frame's canvas or document.
    void Activity( EDA_BASE_FRAME* aFrame, bool aIsWrite );

    /// Something happened in a file (for callers without a frame).
    void Heartbeat( const wxString& aFile, const wxString& aProject, bool aIsWrite );

    struct CONFIG
    {
        bool     enabled = true;
        wxString apiKey;
        wxString apiUrl;      ///< empty: WakaTime's own
    };

    static wxString ConfigPath();
    static CONFIG   ReadConfig();
    static bool     WriteConfig( const CONFIG& aConfig );

    /// The wakatime-cli binary to use, or empty when none is installed.
    static wxString FindCli();

    /// The WakaTime language of a file: "KiCad Schematic", "KiCad PCB", ...
    static wxString LanguageOf( const wxString& aFile );

    /// What the last heartbeat did ("sent with wakatime-cli", "accepted (201)", an error).
    wxString LastStatus() const;

    /// Post one heartbeat now and wait for the answer (Preferences' Send Test Heartbeat).
    bool SendTest( wxString& aStatus );

    static constexpr long HEARTBEAT_EVERY_MS = 120 * 1000;

private:
    WAKATIME() = default;

    void send( const wxString& aFile, const wxString& aProject, const wxString& aLanguage,
               bool aIsWrite, bool aWait, wxString* aStatus,
               const wxString& aEntityType = wxT( "file" ) );
    void reloadConfig();

    mutable std::mutex m_lock;
    wxString           m_lastFile;
    long long          m_lastAt = 0;
    bool               m_lastWrite = false;
    CONFIG             m_config;
    long long          m_configReadAt = 0;
    wxString           m_cli;
    wxString           m_status;
};

#endif // WAKATIME_H
