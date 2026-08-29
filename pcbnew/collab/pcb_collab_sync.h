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
#include <map>
#include <set>
#include <string>

#include <collab/collab_journal.h>
#include <kiid.h>
#include <nlohmann/json.hpp>
#include <wx/event.h>
#include <wx/string.h>

class BOARD;
class BOARD_COMMIT;
class BOARD_ITEM;
class COMMIT;
class PCB_EDIT_FRAME;
class PICKED_ITEMS_LIST;

namespace KIGFX
{
class PCB_VIEW;
}


namespace PCB_COLLAB
{

/**
 * Serialize a single board item to a self-contained s-expression fragment that
 * PCB_IO_KICAD_SEXPR::Parse() accepts.  UUIDs and net assignments are preserved
 * (unlike the clipboard path, which scrubs both).  Zone fills are stripped —
 * fills are recomputed locally and would dominate the wire otherwise.
 */
std::string FormatItemSexpr( const BOARD_ITEM* aItem );

/**
 * Apply one wire-format change object to a board.
 *
 * The change is a JSON object shaped like ITEM_CHANGE::ToJson() with an upper-case
 * "kind" ("ADDED" / "REMOVED" / "MODIFIED"), a bare-KIID "id", and (for ADDED or a
 * whole-item-replace MODIFIED) an "sexpr" payload plus an optional "netName" used
 * to re-resolve the net against the receiving board.
 *
 * Conflict rules are last-writer-wins, identical to the schematic applier: MODIFIED
 * sets properties unconditionally, ADDED with an existing UUID replaces (upsert),
 * REMOVED / MODIFIED of an unknown UUID is a silent no-op.  UUIDs are never
 * rewritten.
 *
 * When @p aCommit is provided the mutation is staged through it and the caller
 * pushes (with SKIP_UNDO); a REMOVED item is detached by the push but not freed,
 * so it is returned through @p aRemovedItem for the caller to purge from the undo
 * stacks and delete.  Without a commit the board is mutated directly (headless /
 * QA use) and removed items are freed immediately.
 *
 * @param aView the live canvas view, needed to swap child view items on footprint
 *              and table replaces; may be null (headless).
 * @return false when the change is malformed or could not be applied.
 */
bool ApplyItemChange( BOARD* aBoard, const nlohmann::json& aChange, BOARD_COMMIT* aCommit,
                      BOARD_ITEM** aRemovedItem = nullptr, KIGFX::PCB_VIEW* aView = nullptr );

} // namespace PCB_COLLAB


/**
 * Live co-editing engine for one PCB_EDIT_FRAME: captures local edits as wire-format
 * ops and applies remote ops to the board.  The board editor is single-document, so
 * unlike the schematic engine there is exactly one server doc id.
 *
 * Owned by PCB_COLLAB_TOOL and alive only while a collaboration session is active, so
 * every hook that reaches it is guarded on a null check and a sessionless build behaves
 * exactly as before.  Everything runs on the UI thread.
 */
class PCB_COLLAB_SYNC : public wxEvtHandler
{
public:
    PCB_COLLAB_SYNC( PCB_EDIT_FRAME* aFrame, const wxString& aDocId );
    ~PCB_COLLAB_SYNC() override;

    /// True while a remote op batch is being applied (echo suppression).
    bool IsApplyingRemote() const { return m_applyingRemote; }

    /**
     * BOARD_COMMIT::Push hook, called before the entries are applied while the
     * before-images in COMMIT_LINE::m_copy are still alive.  Captures MODIFIED and
     * REMOVED changes.
     *
     * @return the entry count at capture time, to be passed to CaptureCommitEnd().
     */
    size_t CaptureCommitBegin( COMMIT& aCommit, int aCommitFlags );

    /**
     * BOARD_COMMIT::Push hook, called at the end of the push.  Captures ADDED
     * changes plus the entries appended mid-push (teardrop and connectivity
     * side-effects), then sends one op for the batch.
     */
    void CaptureCommitEnd( COMMIT& aCommit, size_t aPreCount, int aCommitFlags );

    /**
     * PCB_BASE_EDIT_FRAME::PutDataInPreviousState hook: broadcast the just-restored
     * state.  Statuses are already inverted: DELETED = the item was just removed,
     * NEWITEM = it was just re-added, CHANGED = the live item now holds the restored
     * data and the picker link holds the pre-undo image.
     */
    void CaptureUndoRedo( PICKED_ITEMS_LIST* aList );

    // COLLAB_DOC_ADAPTER forwards from PCB_COLLAB_TOOL; all arrive on the UI thread.
    void OnRemoteOp( const nlohmann::json& aOpMsg );
    void OnOpsTail( const nlohmann::json& aOpsMsg );
    void OnSnapshot( const nlohmann::json& aSnapshotMsg );
    void OnAck( const wxString& aClientOpId, long long aSeq );

    /**
     * Attach the on-disk op journal for a project and re-stage anything left
     * unacknowledged by a previous run (a crash, or edits made while offline).
     */
    void OpenJournal( const wxString& aProjectPath, const wxString& aProjectName );

    /// Re-send every unacknowledged op; call once the session goes live again.
    void ReplayUnacked();
    void OnSnapshotRequest();
    void OnReset( long long aSeq );

private:
    struct PENDING_OP
    {
        long long      seq = 0;
        wxString       authorClientId;
        nlohmann::json changes;
    };

    ///< Stage wire changes for commit entries [aFrom, aTo); ADDED entries only when
    ///< aAdds, MODIFIED/REMOVED only when aModsAndRemoves.
    void captureEntries( COMMIT& aCommit, size_t aFrom, size_t aTo, bool aAdds,
                         bool aModsAndRemoves );

    ///< Append one wire change for aItem to the pending batch.
    void captureItem( BOARD_ITEM* aItem, BOARD_ITEM* aBefore, int aChangeType );

    ///< Send the staged batch as one op and remember it until acked.
    void flushBatch();

    void onIdle( wxIdleEvent& aEvent );
    void drainQueue();
    void applyOp( const PENDING_OP& aOp );

    ///< Save footprints that arrived from a library we do not have into a
    ///< project-local library, so the reference resolves here too.
    void saveMissingLibraries( const nlohmann::json& aChanges );

private:
    PCB_EDIT_FRAME* m_frame;
    wxString        m_docId;          ///< the board's server doc id

    bool            m_applyingRemote;
    int             m_opCounter;      ///< monotonic per-process op counter

    nlohmann::json  m_batch;          ///< wire changes staged for the op being captured

    ///< KIIDs already staged in m_batch, to dedupe child edits promoted to their
    ///< parent footprint.
    std::set<KIID>  m_batchIds;

    ///< Library nicknames already handled by saveMissingLibraries this session.
    std::set<wxString> m_savedLibNicknames;

    struct UNACKED
    {
        nlohmann::json changes;
    };

    ///< clientOpId -> sent-but-unacked op. Mirrored to m_journal so edits made
    ///< while offline (or lost to a crash mid-flight) can be replayed.
    std::map<wxString, UNACKED> m_unacked;

    COLLAB_JOURNAL              m_journal;

    long long             m_lastAppliedSeq; ///< last applied/acked seq
    bool                  m_resyncPending;  ///< resync requested, tail awaited
    std::deque<PENDING_OP> m_queue;         ///< inbound ops awaiting idle-time apply
};
