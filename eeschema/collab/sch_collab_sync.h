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
#include <nlohmann/json.hpp>
#include <wx/event.h>
#include <wx/string.h>

class COMMIT;
class PICKED_ITEMS_LIST;
class SCH_COMMIT;
class SCH_EDIT_FRAME;
class SCH_ITEM;
class SCH_SCREEN;
class SCHEMATIC;


namespace SCH_COLLAB
{

/**
 * Serialize a single schematic item to a self-contained s-expression fragment that
 * SCH_IO_KICAD_SEXPR::LoadContent() accepts.  UUIDs are preserved; symbols embed their
 * library symbol (the clipboard-copy format).
 *
 * @param aScreen the screen the item lives on (or is being added to); required to embed
 *                library symbols for SCH_SYMBOLs.
 */
std::string FormatItemSexpr( SCHEMATIC& aSchematic, SCH_SCREEN* aScreen, SCH_ITEM* aItem );

/**
 * Apply one wire-format change object to a schematic.
 *
 * The change is a JSON object shaped like ITEM_CHANGE::ToJson() with an upper-case
 * "kind" ("ADDED" / "REMOVED" / "MODIFIED"), a bare-KIID "id", and (for ADDED or a
 * whole-item-replace MODIFIED) an "sexpr" payload.
 *
 * Conflict rules are last-writer-wins: MODIFIED sets properties unconditionally,
 * ADDED with an existing UUID replaces (upsert), REMOVED / MODIFIED of an unknown
 * UUID is a silent no-op.  UUIDs are never rewritten.
 *
 * When @p aCommit is provided the mutation is staged through it and the caller is
 * responsible for pushing (with SKIP_UNDO | SKIP_CLEANUP); a REMOVED item is detached
 * by the push but not freed, so it is returned through @p aRemovedItem for the caller
 * to purge from the undo stacks and delete.  Without a commit the screen is mutated
 * directly (headless / QA use) and removed items are freed immediately.
 *
 * @return false when the change is malformed or could not be applied.
 */
bool ApplyItemChange( SCHEMATIC& aSchematic, SCH_SCREEN* aScreen, const nlohmann::json& aChange,
                      SCH_COMMIT* aCommit, SCH_ITEM** aRemovedItem = nullptr );

} // namespace SCH_COLLAB


/**
 * Live co-editing engine for one SCH_EDIT_FRAME: captures local edits as wire-format
 * ops and applies remote ops to the document.
 *
 * Owned by SCH_COLLAB_TOOL and alive only while a collaboration session is active, so
 * every hook that reaches it is guarded on a null check and a sessionless build behaves
 * exactly as before.  Everything runs on the UI thread.
 */
class SCH_COLLAB_SYNC : public wxEvtHandler
{
public:
    SCH_COLLAB_SYNC( SCH_EDIT_FRAME* aFrame, const std::map<wxString, wxString>& aDocIdByPath );
    ~SCH_COLLAB_SYNC() override;

    /// True while a remote op batch is being applied (echo suppression).
    bool IsApplyingRemote() const { return m_applyingRemote; }

    /**
     * SCH_COMMIT::Push hook, called before pushSchEdit() while the before-images in
     * COMMIT_LINE::m_copy are still alive.  Captures MODIFIED and REMOVED changes.
     *
     * @return the entry count at capture time, to be passed to CaptureCommitEnd().
     */
    size_t CaptureCommitBegin( COMMIT& aCommit, int aCommitFlags );

    /**
     * SCH_COMMIT::Push hook, called after pushSchEdit() and before clear().  Captures
     * ADDED changes (post-append, so symbol library caches are populated) plus the
     * connectivity-derived entries SCHEMATIC::CleanUp appended mid-push, then sends
     * one op per touched document.
     */
    void CaptureCommitEnd( COMMIT& aCommit, size_t aPreCount, int aCommitFlags );

    /**
     * SCH_EDIT_FRAME::PutDataInPreviousState hook: broadcast the just-restored state.
     * Statuses are already inverted: DELETED = the item was just removed, NEWITEM = it
     * was just re-added, CHANGED = the live item now holds the restored data and the
     * picker link holds the pre-undo image.
     */
    void CaptureUndoRedo( PICKED_ITEMS_LIST* aList );

    // COLLAB_DOC_ADAPTER forwards from SCH_COLLAB_TOOL; all arrive on the UI thread.
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
        wxString       docId;
        long long      seq = 0;
        wxString       authorClientId;
        nlohmann::json changes;
    };

    ///< Stage wire changes for commit entries [aFrom, end); ADDED entries only when
    ///< aAdds, MODIFIED/REMOVED only when aModsAndRemoves.
    void captureEntries( COMMIT& aCommit, size_t aFrom, size_t aTo, bool aAdds,
                         bool aModsAndRemoves );

    ///< Append one wire change for aItem to the pending batch of aScreen's document.
    void captureItem( SCH_ITEM* aItem, SCH_ITEM* aBefore, SCH_SCREEN* aScreen, int aChangeType );

    ///< Send one op per document with staged changes and remember them until acked.
    void flushBatch();

    void onIdle( wxIdleEvent& aEvent );
    void drainQueue();
    void applyOp( const PENDING_OP& aOp );

    ///< Save symbols that arrived from a library we do not have into a
    ///< project-local library, so the reference resolves here too.
    void saveMissingLibraries( const nlohmann::json& aChanges );

    ///< The server doc id for the document containing aScreen, or empty when the
    ///< screen's file is not part of the shared project.
    wxString docIdForScreen( const SCH_SCREEN* aScreen ) const;

    SCH_SCREEN* screenForDocId( const wxString& aDocId ) const;

    ///< aScreen's file name relative to the project (forward slashes).
    wxString relPathForScreen( const SCH_SCREEN* aScreen ) const;

private:
    SCH_EDIT_FRAME*              m_frame;
    std::map<wxString, wxString> m_docIdByPath;    ///< project-relative path -> server doc id
    std::map<wxString, wxString> m_pathByDocId;

    bool                         m_applyingRemote;
    int                          m_opCounter;      ///< monotonic per-process op counter

    ///< docId -> wire changes staged for the op currently being captured.
    std::map<wxString, nlohmann::json> m_batch;

    struct UNACKED
    {
        wxString       docId;
        nlohmann::json changes;
    };

    ///< clientOpId -> sent-but-unacked op. Mirrored to m_journal so edits made
    ///< while offline (or lost to a crash mid-flight) can be replayed.
    std::map<wxString, UNACKED> m_unacked;

    COLLAB_JOURNAL              m_journal;

    std::map<wxString, long long> m_lastAppliedSeq; ///< docId -> last applied/acked seq
    std::map<wxString, bool>      m_resyncPending;  ///< docId -> resync requested, tail awaited
    std::deque<PENDING_OP>        m_queue;          ///< inbound ops awaiting idle-time apply

    ///< Library nicknames already handled by saveMissingLibraries this session.
    std::set<wxString>            m_savedLibNicknames;
};
