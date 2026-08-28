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

#include <vector>

#include <kicommon.h>
#include <nlohmann/json.hpp>
#include <wx/string.h>

/**
 * Append-only record of ops this client has sent but the server has not yet
 * acknowledged, so edits made while offline (or in flight across a reconnect)
 * can be replayed instead of lost.
 *
 * One ndjson line per op; acknowledged lines are dropped when the file is
 * rewritten.  Lives beside the project as <project>.collab/oplog.ndjson.
 */
class KICOMMON_API COLLAB_JOURNAL
{
public:
    struct ENTRY
    {
        wxString       docId;
        wxString       clientOpId;
        nlohmann::json changes;
    };

    COLLAB_JOURNAL() = default;

    /**
     * Point the journal at a project directory. Existing unacknowledged entries
     * are loaded and are immediately available from Pending().
     */
    void Open( const wxString& aProjectPath, const wxString& aProjectName );

    /// Stop journalling (does not delete the file).
    void Close();

    bool IsOpen() const { return !m_path.IsEmpty(); }

    /// Record an op that has been sent but not yet acknowledged.
    void Append( const wxString& aDocId, const wxString& aClientOpId,
                 const nlohmann::json& aChanges );

    /// Drop an op the server has acknowledged.
    void Ack( const wxString& aClientOpId );

    /// Ops still awaiting acknowledgement, oldest first.
    const std::vector<ENTRY>& Pending() const { return m_pending; }

    /// Forget everything (e.g. after a full resync made local ops moot).
    void Clear();

private:
    void load();
    void rewrite();

    wxString           m_path;
    std::vector<ENTRY> m_pending;
    /// Acked lines still sitting in the file; rewrite once they pile up.
    size_t             m_staleLines = 0;
};
