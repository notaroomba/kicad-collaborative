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

#include "sch_collab_sync.h"

#include <set>

#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>

#include <commit.h>
#include <connection_graph.h>
#include <diff_merge/kicad_diff_types.h>
#include <diff_merge/property_diff.h>
#include <diff_merge/sch_diff_utils.h>
#include <ki_exception.h>
#include <lib_symbol.h>
#include <libraries/library_manager.h>
#include <libraries/library_table.h>
#include <pgm_base.h>
#include <project.h>
#include <settings/common_settings.h>
#include <richio.h>
#include <sch_commit.h>
#include <sch_edit_frame.h>
#include <sch_io/kicad_sexpr/sch_io_kicad_sexpr.h>
#include <sch_item.h>
#include <sch_screen.h>
#include <sch_sheet.h>
#include <sch_sheet_path.h>
#include <sch_symbol.h>
#include <schematic.h>
#include <tool/tool_manager.h>
#include <tools/sch_selection.h>
#include <tools/sch_selection_tool.h>
#include <undo_redo_container.h>

#include <wx/app.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/utils.h>

using namespace KICAD_DIFF;

static const wxChar* const traceCollab = wxT( "COLLAB" );


namespace
{

/// Types whose ADDED / whole-item-replace ops are deferred to a later milestone:
/// a lone SCH_SHEET fragment parses without its screen (swapping would null the live
/// screen), and a lone SCH_GROUP fragment cannot resolve its member UUIDs.
bool typeSupportsSexprTransfer( const SCH_ITEM* aItem )
{
    return aItem->Type() != SCH_SHEET_T && aItem->Type() != SCH_GROUP_T;
}


/// Scoped echo-suppression flag.
struct APPLYING_REMOTE_SCOPE
{
    APPLYING_REMOTE_SCOPE( bool& aFlag ) : m_flag( aFlag ) { m_flag = true; }
    ~APPLYING_REMOTE_SCOPE() { m_flag = false; }

    bool& m_flag;
};


/**
 * Parse a single-item s-expression fragment (the clipboard format) and hand back the
 * item matching aExpectedId, detached from the temporary parse screen and re-parented
 * to aDestScreen.  Returns nullptr on parse failure or when no matching item exists.
 */
SCH_ITEM* parseItemSexpr( SCHEMATIC& aSchematic, SCH_SCREEN* aDestScreen,
                          const std::string& aSexpr, const KIID& aExpectedId )
{
    SCH_SHEET tempSheet;

    // Screen object on heap is owned by the sheet (the paste-path pattern).
    SCH_SCREEN* tempScreen = new SCH_SCREEN( &aSchematic );
    tempSheet.SetScreen( tempScreen );

    STRING_LINE_READER reader( aSexpr, wxS( "collab" ) );
    SCH_IO_KICAD_SEXPR plugin;

    try
    {
        plugin.LoadContent( reader, &tempSheet );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "parseItemSexpr: parse failed: %s" ), ioe.What() );
        return nullptr;
    }

    std::vector<SCH_ITEM*> parsed;

    for( SCH_ITEM* item : tempScreen->Items() )
        parsed.push_back( item );

    SCH_ITEM* found = nullptr;

    for( SCH_ITEM* item : parsed )
    {
        if( item->m_Uuid == aExpectedId )
        {
            found = item;
            break;
        }
    }

    if( !found && parsed.size() == 1 )
        found = parsed.front();

    if( found && found->Type() == SCH_SYMBOL_T )
    {
        // A parsed fragment does not link symbols to their library symbols; do what
        // paste does: prefer the fragment's embedded copy, fall back to the
        // destination screen's cache.
        SCH_SYMBOL*       symbol = static_cast<SCH_SYMBOL*>( found );
        const LIB_SYMBOL* source = nullptr;

        auto it = tempScreen->GetLibSymbols().find( symbol->GetSchSymbolLibraryName() );

        if( it != tempScreen->GetLibSymbols().end() )
            source = it->second;
        else if( aDestScreen )
        {
            auto destIt = aDestScreen->GetLibSymbols().find( symbol->GetSchSymbolLibraryName() );

            if( destIt != aDestScreen->GetLibSymbols().end() )
                source = destIt->second;
        }

        if( source )
            symbol->SetLibSymbol( new LIB_SYMBOL( *source ) );
    }

    // Remove the references from the temporary screen to prevent freeing on the DTOR,
    // then free everything we are not returning.
    tempScreen->Clear( false );

    for( SCH_ITEM* item : parsed )
    {
        if( item != found )
            delete item;
    }

    // Re-parent so the item can reach the SCHEMATIC before it is appended to a screen.
    if( found )
        found->SetParent( aDestScreen );

    return found;
}


const char* changeKindWireString( CHANGE_KIND aKind )
{
    // The server validates against upper-case spellings; the in-tree
    // ChangeKindToString() strings are lower-case, so map explicitly.
    switch( aKind )
    {
    case CHANGE_KIND::ADDED:    return "ADDED";
    case CHANGE_KIND::REMOVED:  return "REMOVED";
    case CHANGE_KIND::MODIFIED: return "MODIFIED";
    default:                    return "MODIFIED";
    }
}

} // anonymous namespace


std::string SCH_COLLAB::FormatItemSexpr( SCHEMATIC& aSchematic, SCH_SCREEN* aScreen,
                                         SCH_ITEM* aItem )
{
    wxCHECK( aItem, std::string() );

    SCH_SELECTION selection( aScreen );
    selection.Add( aItem );

    if( !aSchematic.HasHierarchy() )
        aSchematic.RefreshHierarchy();

    SCH_SHEET_LIST hierarchy = aSchematic.Hierarchy();
    SCH_SHEET_PATH path = hierarchy.FindSheetForScreen( aScreen );

    STRING_FORMATTER   formatter;
    SCH_IO_KICAD_SEXPR plugin;

    // aForClipboard preserves UUIDs and instance data; this is exactly the string
    // SCH_EDITOR_CONTROL::doCopy() puts on the clipboard for one item.
    plugin.Format( &selection, &path, aSchematic, &formatter, true );

    return formatter.GetString();
}


bool SCH_COLLAB::ApplyItemChange( SCHEMATIC& aSchematic, SCH_SCREEN* aScreen,
                                  const nlohmann::json& aChange, SCH_COMMIT* aCommit,
                                  SCH_ITEM** aRemovedItem )
{
    if( !aChange.is_object() )
        return false;

    try
    {
        KIID        id( wxString::FromUTF8( aChange.value( "id", "" ) ) );
        std::string kind = aChange.value( "kind", "" );
        std::string sexpr = aChange.value( "sexpr", "" );

        if( !aSchematic.HasHierarchy() )
            aSchematic.RefreshHierarchy();

        SCH_ITEM* item = aSchematic.ResolveItem( id, nullptr, true );

        // Ops address top-level screen items only; a hit on a child (field, pin) means
        // a malformed or unsupported op.
        if( item && !dynamic_cast<SCH_SCREEN*>( item->GetParent() ) )
        {
            wxLogTrace( traceCollab, wxS( "ApplyItemChange: %s addresses a child item; skipped" ),
                        id.AsString() );
            return false;
        }

        SCH_SCREEN* screen = item ? static_cast<SCH_SCREEN*>( item->GetParent() ) : aScreen;

        if( kind == "REMOVED" )
        {
            if( !item )
                return true;    // already gone: delete beats concurrent modify (LWW)

            if( item->Type() == SCH_SHEET_T )
            {
                wxLogTrace( traceCollab, wxS( "ApplyItemChange: sheet removal not supported yet" ) );
                return false;
            }

            if( aCommit )
            {
                aCommit->Remove( item, screen );

                if( aRemovedItem )
                    *aRemovedItem = item;
            }
            else
            {
                screen->Remove( item );
                delete item;
            }

            return true;
        }

        if( kind == "ADDED" || ( kind == "MODIFIED" && !sexpr.empty() ) )
        {
            if( !aScreen && !item )
                return false;

            SCH_ITEM* fresh = parseItemSexpr( aSchematic, screen ? screen : aScreen, sexpr, id );

            if( !fresh )
                return false;

            if( !typeSupportsSexprTransfer( fresh ) )
            {
                wxLogTrace( traceCollab, wxS( "ApplyItemChange: %s transfer not supported yet" ),
                            fresh->GetClass() );
                delete fresh;
                return false;
            }

            if( item )
            {
                // Upsert-replace: highest seq wins wholesale.
                if( aCommit )
                    aCommit->Modify( item, screen );

                item->SwapItemData( fresh );

                if( item->Type() == SCH_SYMBOL_T )
                {
                    // The old pin objects were swapped into `fresh` and die with it;
                    // scrub them from the connection graph (see SCH_COMMIT::Revert).
                    if( CONNECTION_GRAPH* graph = aSchematic.ConnectionGraph() )
                    {
                        SCH_SYMBOL* freshSymbol = static_cast<SCH_SYMBOL*>( fresh );
                        graph->RemoveItem( freshSymbol );

                        for( SCH_PIN* pin : freshSymbol->GetPins() )
                            graph->RemoveItem( pin );
                    }

                    static_cast<SCH_SYMBOL*>( item )->UpdatePins();
                }

                delete fresh;

                if( !aCommit && screen )
                    screen->Update( item );
            }
            else if( kind == "ADDED" )
            {
                if( aCommit )
                    aCommit->Add( fresh, aScreen );
                else
                    aScreen->Append( fresh );
            }
            else
            {
                // Replace of an item deleted in the meantime: delete beats modify.
                delete fresh;
            }

            return true;
        }

        if( kind == "MODIFIED" )
        {
            if( !item )
                return true;    // deleted concurrently: no-op (LWW)

            std::vector<PROPERTY_RESOLUTION> resolutions;

            for( const nlohmann::json& propJson : aChange.value( "properties",
                                                                 nlohmann::json::array() ) )
            {
                PROPERTY_DELTA delta = PROPERTY_DELTA::FromJson( propJson );

                PROPERTY_RESOLUTION resolution;
                resolution.name = delta.name;
                resolution.kind = PROP_RES::CUSTOM;
                resolution.customValue = delta.after;
                resolutions.push_back( std::move( resolution ) );
            }

            if( resolutions.empty() )
                return true;

            if( aCommit )
                aCommit->Modify( item, screen );

            {
                // Property Get/Set on symbols resolves against the current sheet.
                SCH_SHEET_LIST hierarchy = aSchematic.Hierarchy();
                SCH_SHEET_PATH path = hierarchy.FindSheetForScreen( screen );
                SHEET_SCOPE    scope( &aSchematic, &path );

                // The CUSTOM path sources values from the resolution payload only, so
                // no ours/theirs/ancestor items are needed.
                ApplyPropertyResolutions( item, resolutions, nullptr, nullptr, nullptr );
            }

            if( item->Type() == SCH_SYMBOL_T )
                static_cast<SCH_SYMBOL*>( item )->UpdatePins();

            if( !aCommit && screen )
                screen->Update( item );

            return true;
        }

        wxLogTrace( traceCollab, wxS( "ApplyItemChange: unknown change kind '%s'" ),
                    wxString::FromUTF8( kind ) );
        return false;
    }
    catch( const nlohmann::json::exception& e )
    {
        wxLogTrace( traceCollab, wxS( "ApplyItemChange: malformed change: %s" ),
                    wxString::FromUTF8( e.what() ) );
        return false;
    }
}


SCH_COLLAB_SYNC::SCH_COLLAB_SYNC( SCH_EDIT_FRAME* aFrame,
                                  const std::map<wxString, wxString>& aDocIdByPath ) :
        m_frame( aFrame ),
        m_docIdByPath( aDocIdByPath ),
        m_applyingRemote( false ),
        m_opCounter( 0 )
{
    for( const auto& [path, docId] : m_docIdByPath )
        m_pathByDocId[ docId ] = path;

    m_frame->Bind( wxEVT_IDLE, &SCH_COLLAB_SYNC::onIdle, this );
}


SCH_COLLAB_SYNC::~SCH_COLLAB_SYNC()
{
    m_frame->Unbind( wxEVT_IDLE, &SCH_COLLAB_SYNC::onIdle, this );
}


wxString SCH_COLLAB_SYNC::relPathForScreen( const SCH_SCREEN* aScreen ) const
{
    if( !aScreen )
        return wxEmptyString;

    wxFileName fn( aScreen->GetFileName() );
    fn.MakeRelativeTo( m_frame->Prj().GetProjectPath() );

    return fn.GetFullPath( wxPATH_UNIX );
}


wxString SCH_COLLAB_SYNC::docIdForScreen( const SCH_SCREEN* aScreen ) const
{
    auto it = m_docIdByPath.find( relPathForScreen( aScreen ) );

    return it == m_docIdByPath.end() ? wxString() : it->second;
}


SCH_SCREEN* SCH_COLLAB_SYNC::screenForDocId( const wxString& aDocId ) const
{
    auto it = m_pathByDocId.find( aDocId );

    if( it == m_pathByDocId.end() )
        return nullptr;

    SCH_SHEET_LIST hierarchy = m_frame->Schematic().Hierarchy();

    for( const SCH_SHEET_PATH& path : hierarchy )
    {
        SCH_SCREEN* screen = path.LastScreen();

        if( screen && relPathForScreen( screen ) == it->second )
            return screen;
    }

    return nullptr;
}


size_t SCH_COLLAB_SYNC::CaptureCommitBegin( COMMIT& aCommit, int aCommitFlags )
{
    size_t count = aCommit.GetEntries().size();

    if( m_applyingRemote || !COLLAB_SESSION::Get().IsLive() )
        return count;

    // Before-images (COMMIT_LINE::m_copy) are consumed during pushSchEdit, so MODIFIED
    // and REMOVED must be captured now.  ADDED is deferred to CaptureCommitEnd: new
    // symbols reach the screen's library-symbol cache during the push, and the sexpr
    // payload embeds from that cache.
    captureEntries( aCommit, 0, count, false, true );

    return count;
}


void SCH_COLLAB_SYNC::CaptureCommitEnd( COMMIT& aCommit, size_t aPreCount, int aCommitFlags )
{
    if( m_applyingRemote || !COLLAB_SESSION::Get().IsLive() )
        return;

    size_t count = aCommit.GetEntries().size();

    captureEntries( aCommit, 0, std::min( aPreCount, count ), true, false );

    // Entries appended mid-push: connectivity-derived CHT_DONE adds/removes from
    // SCHEMATIC::CleanUp, plus group modifications staged inside pushSchEdit (whose
    // before-images are already consumed).
    if( count > aPreCount )
        captureEntries( aCommit, aPreCount, count, true, true );

    flushBatch();
}


void SCH_COLLAB_SYNC::captureEntries( COMMIT& aCommit, size_t aFrom, size_t aTo, bool aAdds,
                                      bool aModsAndRemoves )
{
    const std::vector<COMMIT::COMMIT_LINE>& entries = aCommit.GetEntries();

    for( size_t ii = aFrom; ii < aTo && ii < entries.size(); ++ii )
    {
        const COMMIT::COMMIT_LINE& entry = entries[ii];

        SCH_ITEM*   item = dynamic_cast<SCH_ITEM*>( entry.m_item );
        SCH_SCREEN* screen = dynamic_cast<SCH_SCREEN*>( entry.m_screen );
        int         changeType = entry.m_type & CHT_TYPE;

        if( !item || !screen )
            continue;

        if( changeType == CHT_ADD && !aAdds )
            continue;

        if( ( changeType == CHT_REMOVE || changeType == CHT_MODIFY ) && !aModsAndRemoves )
            continue;

        captureItem( item, dynamic_cast<SCH_ITEM*>( entry.m_copy ), screen, changeType );
    }
}


void SCH_COLLAB_SYNC::captureItem( SCH_ITEM* aItem, SCH_ITEM* aBefore, SCH_SCREEN* aScreen,
                                   int aChangeType )
{
    wxString docId = docIdForScreen( aScreen );

    if( docId.IsEmpty() )
        return;

    ITEM_CHANGE change;
    change.id.emplace_back( aItem->m_Uuid );
    change.typeName = aItem->GetClass();
    change.bbox = aItem->GetBoundingBox();

    std::string sexpr;

    switch( aChangeType )
    {
    case CHT_ADD:
        if( !typeSupportsSexprTransfer( aItem ) )
        {
            wxLogTrace( traceCollab, wxS( "capture: skipping unsupported add of %s" ),
                        aItem->GetClass() );
            return;
        }

        change.kind = CHANGE_KIND::ADDED;
        sexpr = SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), aScreen, aItem );

        if( sexpr.empty() )
            return;

        break;

    case CHT_REMOVE:
        if( aItem->Type() == SCH_SHEET_T )
        {
            wxLogTrace( traceCollab, wxS( "capture: skipping unsupported sheet removal" ) );
            return;
        }

        change.kind = CHANGE_KIND::REMOVED;
        break;

    case CHT_MODIFY:
    {
        change.kind = CHANGE_KIND::MODIFIED;

        std::vector<PROPERTY_DELTA> deltas;

        if( aBefore )
        {
            // Property enumeration on symbols resolves against the current sheet.
            SCH_SHEET_LIST hierarchy = m_frame->Schematic().Hierarchy();
            SCH_SHEET_PATH path = hierarchy.FindSheetForScreen( aScreen );
            SHEET_SCOPE    scope( &m_frame->Schematic(), &path );

            deltas = DiffItemProperties( aBefore, aItem );
        }

        // Items are routinely staged without being changed (e.g. a dialog OK'd with no
        // edits); suppress those the same way SCH_DIFFER does, by trusting operator==.
        if( aBefore && deltas.empty() && *aBefore == *aItem )
            return;

        if( !deltas.empty() )
        {
            change.properties = std::move( deltas );
        }
        else
        {
            // No property-level delta available (either the change isn't visible to the
            // property system or the before-image is gone): fall back to a whole-item
            // replace so the edit is not dropped.
            if( !typeSupportsSexprTransfer( aItem ) )
            {
                wxLogTrace( traceCollab, wxS( "capture: skipping delta-less modify of %s" ),
                            aItem->GetClass() );
                return;
            }

            sexpr = SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), aScreen, aItem );

            if( sexpr.empty() )
                return;
        }

        break;
    }

    default:
        return;
    }

    nlohmann::json wire = change.ToJson();

    // The wire id is the item's own KIID (KIID_PATH::AsString() would prepend '/'),
    // and the server validates upper-case kinds.
    wire[ "id" ] = aItem->m_Uuid.AsStdString();
    wire[ "kind" ] = changeKindWireString( change.kind );
    wire[ "screen" ] = relPathForScreen( aScreen ).ToStdString( wxConvUTF8 );

    if( !sexpr.empty() )
        wire[ "sexpr" ] = sexpr;

    nlohmann::json& batch = m_batch[ docId ];

    if( !batch.is_array() )
        batch = nlohmann::json::array();

    batch.push_back( std::move( wire ) );
}


void SCH_COLLAB_SYNC::flushBatch()
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    for( auto& [docId, changes] : m_batch )
    {
        if( !changes.is_array() || changes.empty() )
            continue;

        wxString clientOpId = wxString::Format( wxS( "%s:%d" ), session.ClientId(),
                                                ++m_opCounter );

        std::optional<long long> baseSeq;
        auto                     seqIt = m_lastAppliedSeq.find( docId );

        if( seqIt != m_lastAppliedSeq.end() )
            baseSeq = seqIt->second;

        // Journal before sending: an op that reaches the server but whose ack
        // we never see must still be replayable (the server dedups it).
        m_journal.Append( docId, clientOpId, changes );

        session.SendOp( docId, clientOpId, baseSeq, changes );

        m_unacked[ clientOpId ] = { docId, std::move( changes ) };
    }

    m_batch.clear();
}


void SCH_COLLAB_SYNC::CaptureUndoRedo( PICKED_ITEMS_LIST* aList )
{
    if( !aList || m_applyingRemote || !COLLAB_SESSION::Get().IsLive() )
        return;

    for( unsigned ii = 0; ii < aList->GetCount(); ++ii )
    {
        UNDO_REDO   status = aList->GetPickedItemStatus( ii );
        SCH_ITEM*   item = dynamic_cast<SCH_ITEM*>( aList->GetPickedItem( ii ) );
        SCH_SCREEN* screen = dynamic_cast<SCH_SCREEN*>( aList->GetScreenForItem( ii ) );

        if( !item || !screen )
            continue;

        switch( status )
        {
        case UNDO_REDO::DELETED:
            // Inverted status: the item was just removed from the screen.
            captureItem( item, nullptr, screen, CHT_REMOVE );
            break;

        case UNDO_REDO::NEWITEM:
            // Inverted status: the item was just re-added to the screen.
            captureItem( item, nullptr, screen, CHT_ADD );
            break;

        case UNDO_REDO::CHANGED:
            // The live item holds the restored (now authoritative) state; the link
            // holds the pre-undo image, i.e. the wire-perspective "before".
            captureItem( item, dynamic_cast<SCH_ITEM*>( aList->GetPickedItemLink( ii ) ),
                         screen, CHT_MODIFY );
            break;

        default:
            // PAGESETTINGS, REPEAT_ITEM, etc. are not document items.
            break;
        }
    }

    flushBatch();
}


void SCH_COLLAB_SYNC::OnRemoteOp( const nlohmann::json& aOpMsg )
{
    PENDING_OP op;
    op.docId = wxString::FromUTF8( aOpMsg.value( "docId", "" ) );
    op.seq = aOpMsg.value( "seq", 0LL );
    op.changes = aOpMsg.value( "changes", nlohmann::json::array() );

    if( aOpMsg.contains( "author" ) && aOpMsg[ "author" ].is_object() )
        op.authorClientId = wxString::FromUTF8( aOpMsg[ "author" ].value( "clientId", "" ) );

    if( op.docId.IsEmpty() || op.seq <= 0 )
        return;

    m_queue.push_back( std::move( op ) );
    wxWakeUpIdle();
}


void SCH_COLLAB_SYNC::OnOpsTail( const nlohmann::json& aOpsMsg )
{
    wxString docId = wxString::FromUTF8( aOpsMsg.value( "docId", "" ) );

    if( docId.IsEmpty() )
        return;

    m_resyncPending[ docId ] = false;

    // Anything queued before the tail is superseded by it; stale pre-tail broadcasts
    // would otherwise re-trigger gap detection and ping-pong resync requests.
    std::erase_if( m_queue,
                   [&]( const PENDING_OP& aPending )
                   {
                       return aPending.docId == docId;
                   } );

    for( const nlohmann::json& opJson : aOpsMsg.value( "ops", nlohmann::json::array() ) )
    {
        PENDING_OP op;
        op.docId = docId;
        op.seq = opJson.value( "seq", 0LL );
        op.changes = opJson.value( "changes", nlohmann::json::array() );

        if( opJson.contains( "author" ) && opJson[ "author" ].is_object() )
            op.authorClientId = wxString::FromUTF8( opJson[ "author" ].value( "clientId", "" ) );

        if( op.seq > 0 )
            m_queue.push_back( std::move( op ) );
    }

    wxWakeUpIdle();
}


void SCH_COLLAB_SYNC::OnSnapshot( const nlohmann::json& aSnapshotMsg )
{
    // v1: we do not hot-load the snapshot file; the local copy of the project is
    // assumed to match the server snapshot (true for the uploader and for fresh
    // archive joins).  The full stale-file resync flow is M5.
    wxString  docId = wxString::FromUTF8( aSnapshotMsg.value( "docId", "" ) );
    long long seq = aSnapshotMsg.value( "seq", 0LL );

    if( docId.IsEmpty() )
        return;

    wxLogTrace( traceCollab, wxS( "snapshot for %s at seq %lld (file body ignored in v1)" ),
                docId, seq );

    if( m_lastAppliedSeq[ docId ] < seq )
        m_lastAppliedSeq[ docId ] = seq;

    COLLAB_SESSION::Get().SetAppliedSeq( docId, m_lastAppliedSeq[ docId ] );

    m_resyncPending[ docId ] = false;

    std::erase_if( m_queue,
                   [&]( const PENDING_OP& aPending )
                   {
                       return aPending.docId == docId;
                   } );

    // Replay the ops since the snapshot through the normal queue.
    for( const nlohmann::json& opJson : aSnapshotMsg.value( "thenOps",
                                                            nlohmann::json::array() ) )
    {
        PENDING_OP op;
        op.docId = docId;
        op.seq = opJson.value( "seq", 0LL );
        op.changes = opJson.value( "changes", nlohmann::json::array() );

        if( opJson.contains( "author" ) && opJson[ "author" ].is_object() )
            op.authorClientId = wxString::FromUTF8( opJson[ "author" ].value( "clientId", "" ) );

        if( op.seq > 0 )
            m_queue.push_back( std::move( op ) );
    }

    wxWakeUpIdle();
}


void SCH_COLLAB_SYNC::OnAck( const wxString& aClientOpId, long long aSeq )
{
    auto it = m_unacked.find( aClientOpId );

    if( it == m_unacked.end() )
        return;

    // Advance lastAppliedSeq through the queue rather than directly: broadcasts of
    // earlier remote ops may still be queued, and skipping past them would drop edits.
    PENDING_OP marker;
    marker.docId = it->second.docId;
    marker.seq = aSeq;
    marker.authorClientId = COLLAB_SESSION::Get().ClientId();

    m_queue.push_back( std::move( marker ) );
    m_ownRecent[ it->second.docId ][ aSeq ] = std::move( it->second.changes );
    m_unacked.erase( it );
    m_journal.Ack( aClientOpId );

    wxWakeUpIdle();
}


void SCH_COLLAB_SYNC::OnOpRejected( const wxString& aClientOpId )
{
    auto it = m_unacked.find( aClientOpId );

    if( it == m_unacked.end() )
        return;

    wxString docId = it->second.docId;
    m_unacked.erase( it );

    // Rejected is as final as acked for replay purposes: the server will
    // refuse it again on every reconnect forever.
    m_journal.Ack( aClientOpId );

    // The op was applied optimistically here; a resync (snapshot + tail)
    // restores the server's version of the document.
    if( !m_resyncPending[ docId ] )
    {
        m_resyncPending[ docId ] = true;
        COLLAB_SESSION::Get().RequestResync( docId );
    }
}


void SCH_COLLAB_SYNC::OpenJournal( const wxString& aProjectPath, const wxString& aProjectName )
{
    m_journal.Open( aProjectPath, aProjectName );

    // Anything left from a previous run was never acknowledged: re-stage it so
    // the next connection replays it. The server dedups by clientOpId, so a
    // replay of something it already has is harmless.
    for( const COLLAB_JOURNAL::ENTRY& entry : m_journal.Pending() )
        m_unacked[ entry.clientOpId ] = { entry.docId, entry.changes };
}


void SCH_COLLAB_SYNC::ReplayUnacked()
{
    if( m_unacked.empty() )
        return;

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( !session.IsLive() )
        return;

    wxLogTrace( traceCollab, wxS( "replaying %zu unacknowledged op(s)" ), m_unacked.size() );

    for( const auto& [clientOpId, op] : m_unacked )
        session.SendOp( op.docId, clientOpId, std::nullopt, op.changes );
}


void SCH_COLLAB_SYNC::OnSnapshotRequest()
{
    // The adapter interface does not forward the requested doc id, so serve the
    // request for the currently displayed document only.
    SCH_SCREEN* screen = m_frame->GetScreen();
    wxString    docId = docIdForScreen( screen );

    if( docId.IsEmpty() )
        return;

    for( const auto& [opId, unacked] : m_unacked )
    {
        if( unacked.docId == docId )
        {
            wxLogTrace( traceCollab, wxS( "snapshot request skipped: ops in flight for %s" ),
                        docId );
            return;
        }
    }

    SCH_SHEET_LIST hierarchy = m_frame->Schematic().Hierarchy();
    SCH_SHEET*     sheet = nullptr;

    for( const SCH_SHEET_PATH& path : hierarchy )
    {
        if( path.LastScreen() == screen )
        {
            sheet = path.Last();
            break;
        }
    }

    if( !sheet )
        return;

    try
    {
        STRING_FORMATTER   formatter;
        SCH_IO_KICAD_SEXPR plugin;

        plugin.FormatSchematicToFormatter( &formatter, sheet, &m_frame->Schematic() );

        wxString server = COLLAB_SESSION::ServerUrl();

        COLLAB_REST::UploadSnapshot( server, COLLAB_AUTH::StoredToken( server ), docId,
                                     m_lastAppliedSeq[ docId ], formatter.GetString() );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "snapshot serialization failed: %s" ), ioe.What() );
    }
}


void SCH_COLLAB_SYNC::OnReset( long long aSeq )
{
    wxLogTrace( traceCollab, wxS( "server reset to seq %lld" ), aSeq );

    m_queue.clear();
    m_unacked.clear();

    m_frame->ShowInfoBarError( _( "The shared project was reset on the server.  Leave and "
                                  "rejoin the session to resynchronize." ) );
}


void SCH_COLLAB_SYNC::onIdle( wxIdleEvent& aEvent )
{
    aEvent.Skip();

    if( m_queue.empty() || m_applyingRemote )
        return;

    // Defer while the user is actively interacting: a held mouse button covers drags,
    // box selections and wire drawing; the IS_MOVING check covers the click-move-click
    // move tool, whose mouse button is up mid-move.  Interleaving a remote commit with
    // a partially staged local edit is the documented interleaved-commit crash.
    if( wxGetMouseState().LeftIsDown() )
        return;

    if( SCH_SELECTION_TOOL* selTool =
                m_frame->GetToolManager()->GetTool<SCH_SELECTION_TOOL>() )
    {
        for( EDA_ITEM* item : selTool->GetSelection() )
        {
            if( item->IsMoving() )
                return;
        }
    }

    drainQueue();
}


void SCH_COLLAB_SYNC::drainQueue()
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    while( !m_queue.empty() )
    {
        PENDING_OP op = std::move( m_queue.front() );
        m_queue.pop_front();

        long long& lastApplied = m_lastAppliedSeq[ op.docId ];

        // Once lastApplied passes one of our own ops, every future remote op has
        // a higher seq and wins legitimately; the retained copy can go.
        auto& ownRecent = m_ownRecent[ op.docId ];

        while( !ownRecent.empty() && ownRecent.begin()->first <= lastApplied )
            ownRecent.erase( ownRecent.begin() );

        if( m_resyncPending[ op.docId ] )
            continue;   // dropped; the resync tail supersedes anything queued

        if( op.seq <= lastApplied )
            continue;

        if( op.seq > lastApplied + 1 )
        {
            wxLogTrace( traceCollab, wxS( "seq gap on %s: have %lld, got %lld; resyncing" ),
                        op.docId, lastApplied, op.seq );
            m_resyncPending[ op.docId ] = true;
            session.RequestResync( op.docId );
            continue;
        }

        if( !op.authorClientId.IsEmpty() && op.authorClientId == session.ClientId() )
        {
            // Our own op coming back in a tail (or an ack marker): already applied.
            lastApplied = op.seq;
            continue;
        }

        applyOp( op );
        lastApplied = op.seq;

        // Tell the session how far we have actually applied, so a reconnect
        // asks for the tail from here rather than from what merely arrived.
        session.SetAppliedSeq( op.docId, lastApplied );
    }
}


void SCH_COLLAB_SYNC::applyOp( const PENDING_OP& aOp )
{
    SCH_SCREEN* screen = screenForDocId( aOp.docId );

    if( !screen )
    {
        wxLogTrace( traceCollab, wxS( "no local screen for doc %s; op %lld skipped" ),
                    aOp.docId, aOp.seq );
        return;
    }

    if( !aOp.changes.is_array() || aOp.changes.empty() )
        return;

    APPLYING_REMOTE_SCOPE applying( m_applyingRemote );

    SCH_COMMIT             commit( m_frame->GetToolManager() );
    std::vector<SCH_ITEM*> removedItems;

    // A REMOVED + ADDED pair for the same id in one batch would stage the same
    // live object as both a removal and a modification in one commit — the
    // removal wins and the item is destroyed.  Collapse: the ADDED alone upserts.
    std::set<std::string> reAddedIds;

    for( const nlohmann::json& change : aOp.changes )
    {
        if( change.is_object() && change.value( "kind", "" ) == "ADDED" )
            reAddedIds.insert( change.value( "id", "" ) );
    }

    for( const nlohmann::json& change : aOp.changes )
    {
        if( change.is_object() && change.value( "kind", "" ) == "REMOVED"
            && reAddedIds.count( change.value( "id", "" ) ) )
        {
            continue;
        }

        SCH_ITEM* removedItem = nullptr;

        SCH_COLLAB::ApplyItemChange( m_frame->Schematic(), screen, change, &commit,
                                     &removedItem );

        if( removedItem )
            removedItems.push_back( removedItem );
    }

    // Last-writer-wins repair: acks and broadcasts share one in-order stream, so
    // any of our ops still unacked here — and any acked with seq > this op's —
    // is provably NEWER than this remote op.  Re-assert our changes for the
    // items it touched, or a concurrent older edit would clobber ours on our
    // side only and the documents would diverge.
    std::set<std::string> remoteIds;

    for( const nlohmann::json& change : aOp.changes )
    {
        if( change.is_object() )
            remoteIds.insert( change.value( "id", "" ) );
    }

    auto reassert = [&]( const nlohmann::json& aOwnChanges )
    {
        if( !aOwnChanges.is_array() )
            return;

        // Same collapse as the main loop: a REMOVED+ADDED pair for one id must
        // not stage the same live object as both a removal and a modification.
        std::set<std::string> ownReAdded;

        for( const nlohmann::json& change : aOwnChanges )
        {
            if( change.is_object() && change.value( "kind", "" ) == "ADDED" )
                ownReAdded.insert( change.value( "id", "" ) );
        }

        for( const nlohmann::json& change : aOwnChanges )
        {
            if( change.is_object() && change.value( "kind", "" ) == "REMOVED"
                && ownReAdded.count( change.value( "id", "" ) ) )
            {
                continue;
            }

            if( change.is_object() && remoteIds.count( change.value( "id", "" ) ) )
            {
                SCH_ITEM* removedItem = nullptr;
                SCH_COLLAB::ApplyItemChange( m_frame->Schematic(), screen, change, &commit,
                                             &removedItem );

                if( removedItem )
                    removedItems.push_back( removedItem );
            }
        }
    };

    for( const auto& [ownSeq, changes] : m_ownRecent[ aOp.docId ] )
    {
        if( ownSeq > aOp.seq )
            reassert( changes );
    }

    for( const auto& [clientOpId, unacked] : m_unacked )
    {
        if( unacked.docId == aOp.docId )
            reassert( unacked.changes );
    }

    if( !commit.Empty() )
        commit.Push( _( "Remote Edit" ), SKIP_UNDO | SKIP_CLEANUP );

    // The push detached removed items from the screen, view and selection but did not
    // free them (SKIP_UNDO).  Scrub the undo/redo stacks before freeing so a later
    // local undo cannot dereference them.
    for( SCH_ITEM* item : removedItems )
    {
        KIID uuid = item->m_Uuid;

        m_frame->PurgeItemFromUndoRedo( uuid );
        delete item;
    }

    saveMissingLibraries( aOp.changes );
}


void SCH_COLLAB_SYNC::saveMissingLibraries( const nlohmann::json& aChanges )
{
    COMMON_SETTINGS* settings = Pgm().GetCommonSettings();

    if( !settings || !settings->m_Collab.save_missing_libraries )
        return;

    LIBRARY_MANAGER& manager = Pgm().GetLibraryManager();

    for( const nlohmann::json& change : aChanges )
    {
        if( !change.is_object() || change.value( "typeName", "" ) != "SCH_SYMBOL" )
            continue;

        std::string kind = change.value( "kind", "" );

        if( kind != "ADDED" && kind != "MODIFIED" )
            continue;

        KIID      id( wxString::FromUTF8( change.value( "id", "" ) ) );
        SCH_ITEM* item = m_frame->Schematic().ResolveItem( id, nullptr, true );

        if( !item || item->Type() != SCH_SYMBOL_T )
            continue;

        SCH_SYMBOL* symbol = static_cast<SCH_SYMBOL*>( item );
        wxString    nickname = symbol->GetLibId().GetLibNickname();

        if( nickname.IsEmpty() || m_savedLibNicknames.count( nickname )
            || !symbol->GetLibSymbolRef() )
        {
            continue;
        }

        m_savedLibNicknames.insert( nickname );

        std::optional<LIBRARY_MANAGER_ADAPTER*> adapter =
                manager.Adapter( LIBRARY_TABLE_TYPE::SYMBOL );

        if( !adapter || ( *adapter )->HasLibrary( nickname ) )
            continue;

        // The library this symbol claims to come from does not exist here: keep a
        // project-local copy (from the embedded definition) so the reference
        // resolves for us too.
        wxString sanitized = nickname;
        sanitized.Replace( wxS( "/" ), wxS( "_" ) );
        sanitized.Replace( wxS( ":" ), wxS( "_" ) );

        wxFileName libFile( m_frame->Prj().GetProjectPath(), sanitized );
        libFile.AppendDir( settings->m_Collab.local_library_dir );
        libFile.SetExt( wxS( "kicad_sym" ) );

        if( !libFile.DirExists() && !wxFileName::Mkdir( libFile.GetPath(), wxS_DIR_DEFAULT,
                                                        wxPATH_MKDIR_FULL ) )
            continue;

        try
        {
            SCH_IO_KICAD_SEXPR io;

            // The plugin takes ownership of the copy.
            LIB_SYMBOL* copy = new LIB_SYMBOL( *symbol->GetLibSymbolRef() );
            copy->SetName( symbol->GetLibId().GetLibItemName() );
            io.SaveSymbol( libFile.GetFullPath(), copy );
        }
        catch( const IO_ERROR& ioe )
        {
            wxLogTrace( traceCollab, wxS( "saveMissingLibraries: save failed: %s" ),
                        ioe.What() );
            continue;
        }

        std::optional<LIBRARY_TABLE*> table =
                manager.Table( LIBRARY_TABLE_TYPE::SYMBOL, LIBRARY_TABLE_SCOPE::PROJECT );

        if( !table )
            continue;

        LIBRARY_TABLE_ROW& row = ( *table )->InsertRow();
        row.SetNickname( nickname );
        row.SetURI( wxS( "${KIPRJMOD}/" ) + settings->m_Collab.local_library_dir + wxS( "/" )
                    + sanitized + wxS( ".kicad_sym" ) );
        row.SetType( wxS( "KiCad" ) );

        ( *table )->Save();
        manager.ReloadTables( LIBRARY_TABLE_SCOPE::PROJECT, { LIBRARY_TABLE_TYPE::SYMBOL } );

        wxLogTrace( traceCollab, wxS( "saved collaborator library '%s' to %s" ), nickname,
                    libFile.GetFullPath() );
    }
}
