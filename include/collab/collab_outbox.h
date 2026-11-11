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

#include <deque>
#include <functional>
#include <set>
#include <string>
#include <vector>

#include <kicommon.h>
#include <nlohmann/json.hpp>
#include <wx/string.h>

/**
 * The ops this editor has made and the server has not acknowledged yet, in the order they
 * were made.
 *
 * While the connection is up this is the handful of ops in flight.  While it is down the
 * editor keeps working and every edit queues here; when the connection returns the queue
 * goes out oldest first, a window at a time, so a long offline spell neither floods the
 * socket nor reorders two edits of the same item.
 *
 * Lives for the editor's session.  An editor that is closed keeps its offline work in the
 * saved file, and the three-way merge against the sync base carries that online on the
 * next join (see COLLAB_PROJECT), so nothing here is written to disk.
 */
class KICOMMON_API COLLAB_OUTBOX
{
public:
    struct OP
    {
        wxString       clientOpId;
        wxString       docId;
        nlohmann::json changes;
        bool           sent = false;    ///< on the wire of the current connection
    };

    /// How many ops may be awaiting their acknowledgement at once.
    static constexpr size_t WINDOW = 32;

    /**
     * Queue an op that has been applied here.
     *
     * A zone refill ships every zone it touched whole, fill included, and only the last
     * fill of a zone matters: an earlier refill of the same zone still waiting to go out
     * is dropped from its op (and the op with it, if nothing else is left in it).
     */
    void Push( const wxString& aDocId, const wxString& aClientOpId, nlohmann::json aChanges );

    /**
     * Send what the window allows, oldest first.
     *
     * @param aSend puts one op on the wire; false when it cannot go out now (not live, or
     *              its document has not caught up yet).  Later ops of that document are
     *              then held back too, so order within a document is never broken.
     * @return the number of ops sent by this call.
     */
    size_t Pump( const std::function<bool( const OP& )>& aSend );

    /**
     * The server acknowledged (or finally refused) an op.
     *
     * @param aOut receives the op, when given.
     * @return false if no such op is waiting.
     */
    bool Ack( const wxString& aClientOpId, OP* aOut = nullptr );

    /// The connection is gone: nothing is on the wire any more.
    void MarkAllUnsent();

    /// Remove and return the ops of @p aDocId that are not on the wire, oldest first.
    std::vector<OP> TakeUnsent( const wxString& aDocId );

    /// Forget every op of @p aDocId (all documents when empty).
    void Clear( const wxString& aDocId = wxEmptyString );

    /// Every waiting op, oldest first.
    const std::deque<OP>& Ops() const { return m_ops; }

    bool   Empty() const { return m_ops.empty(); }
    size_t Size() const { return m_ops.size(); }

    /// Ops waiting that are not on the wire.
    size_t UnsentCount() const;

    /// Ops of @p aDocId waiting, on the wire or not.
    size_t Count( const wxString& aDocId ) const;

    /// The ids of the items the waiting ops of @p aDocId change.
    std::set<std::string> TouchedIds( const wxString& aDocId ) const;

    /**
     * Delete an op journal left beside the project by an earlier version, which replayed
     * it under a new client id (so the server could not recognise ops it already had) and
     * in the wrong order.
     */
    static void RemoveLegacyJournal( const wxString& aProjectPath, const wxString& aProjectName,
                                     const wxString& aFileName );

private:
    std::deque<OP> m_ops;
};
