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
#include <collab/collab_project.h>
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
#include <sch_painter.h>
#include <sch_plotter.h>
#include <sch_screen.h>
#include <sch_sheet.h>
#include <sch_sheet_path.h>
#include <sch_symbol.h>
#include <schematic.h>
#include <tool/tool_manager.h>
#include <tools/sch_selection.h>
#include <tools/sch_selection_tool.h>
#include <undo_redo_container.h>

#include <reporter.h>
#include <wx/app.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/utils.h>

using namespace KICAD_DIFF;

static const wxChar* const traceCollab = wxT( "COLLAB" );


namespace
{

/// SCH_GROUP fragments cannot resolve their member UUIDs and stay deferred.
/// Sheets transfer: the fragment parses without its screen, so the applier
/// preserves the live screen across an upsert and gives a brand-new sheet an
/// empty screen that the doc-join reconcile then populates.
bool typeSupportsSexprTransfer( const SCH_ITEM* aItem )
{
    return aItem->Type() != SCH_GROUP_T;
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

                // A parsed sheet fragment has no screen; the live sheet's
                // screen (and the file contents behind it) must survive.
                SCH_SCREEN* keepScreen = nullptr;

                if( item->Type() == SCH_SHEET_T )
                    keepScreen = static_cast<SCH_SHEET*>( item )->GetScreen();

                item->SwapItemData( fresh );

                if( item->Type() == SCH_SHEET_T )
                    static_cast<SCH_SHEET*>( item )->SetScreen( keepScreen );

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
                if( fresh->Type() == SCH_SHEET_T )
                {
                    if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
                        fprintf( stderr, "COLLAB sheet: creating screen\n" );

                    SCH_SHEET*  sheet = static_cast<SCH_SHEET*>( fresh );
                    SCH_SCREEN* newScreen = new SCH_SCREEN( &aSchematic );

                    newScreen->SetFileName( sheet->GetFileName() );
                    sheet->SetScreen( newScreen );

                    if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
                        fprintf( stderr, "COLLAB sheet: screen attached\n" );
                }

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
    *m_alive = false;

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
    else if( change.kind == CHANGE_KIND::MODIFIED && typeSupportsSexprTransfer( aItem ) )
    {
        // Clients that mirror the document by re-parsing items (the web editor)
        // need the whole item, not just the property deltas the desktop applies.
        std::string full = SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), aScreen, aItem );

        if( !full.empty() )
            wire[ "itemSexpr" ] = full;
    }

    nlohmann::json& batch = m_batch[ docId ];

    if( !batch.is_array() )
        batch = nlohmann::json::array();

    batch.push_back( std::move( wire ) );
}


void SCH_COLLAB_SYNC::flushBatch()
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    // New hierarchical sheets in this batch bring new files: create their
    // server docs and upload our content before peers try to join them.
    for( auto& [docId, changes] : m_batch )
        ensureSheetDocs( docId, changes, true );

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
    if( !m_previewsPushed )
    {
        m_previewsPushed = true;
        wxTheApp->CallAfter( [this, alive = m_alive]() { if( *alive ) uploadSheetPreviews(); } );
    }

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

    nlohmann::json thenOps = aSnapshotMsg.value( "thenOps", nlohmann::json::array() );

    if( aSnapshotMsg.contains( "file" ) )
    {
        // Every snapshot catch-up merges the screen with the server's state:
        // heals stale/drifted copies on join, carries offline edits back
        // online, serves doc resets, and subsumes the rejected-op rollback.
        // The ops since the snapshot are folded into that merge rather than
        // replayed separately, so the merged screen is at the head seq.
        for( const nlohmann::json& opJson : thenOps )
            m_lastAppliedSeq[ docId ] = std::max( m_lastAppliedSeq[ docId ], opJson.value( "seq", 0LL ) );

        COLLAB_SESSION::Get().SetAppliedSeq( docId, m_lastAppliedSeq[ docId ] );

        m_reconcilePending.erase( docId );
        m_pendingRollback.erase( docId );
        reconcileFromSnapshot( docId, aSnapshotMsg.value( "file", "" ), thenOps );
    }
    else
    {
        // Replay the ops since the snapshot through the normal queue.
        for( const nlohmann::json& opJson : thenOps )
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

    // Remember which items the rejected op touched: the resync snapshot
    // below carries the server's state for them.
    if( it->second.changes.is_array() )
    {
        for( const nlohmann::json& change : it->second.changes )
        {
            if( change.is_object() )
                m_pendingRollback[ docId ].insert(
                        KIID( wxString::FromUTF8( change.value( "id", "" ) ) ) );
        }
    }

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


void SCH_COLLAB_SYNC::reconcileFromSnapshot( const wxString& aDocId,
                                             const std::string& aFileText,
                                             const nlohmann::json& aThenOps )
{
    SCH_SCREEN* screen = screenForDocId( aDocId );

    if( !screen || aFileText.empty() )
        return;

    // Screen objects on the heap are owned by their sheet (the paste-path pattern).
    auto loadTemp = [this]( const std::string& aText, SCH_SHEET& aSheet ) -> SCH_SCREEN*
    {
        SCH_SCREEN* tempScreen = new SCH_SCREEN( &m_frame->Schematic() );
        aSheet.SetScreen( tempScreen );

        STRING_LINE_READER reader( aText, wxS( "collab-merge" ) );
        SCH_IO_KICAD_SEXPR plugin;

        try
        {
            plugin.LoadContent( reader, &aSheet );
        }
        catch( const IO_ERROR& ioe )
        {
            wxLogTrace( traceCollab, wxS( "reconcile: parse failed: %s" ), ioe.What() );
            return nullptr;
        }

        return tempScreen;
    };

    SCH_SHEET   serverSheet;
    SCH_SCREEN* serverScreen = loadTemp( aFileText, serverSheet );

    if( !serverScreen )
        return;

    // The server's truth is the snapshot plus every op since it; fold those in
    // headlessly so the merge sees one consistent online state.
    if( aThenOps.is_array() )
    {
        for( const nlohmann::json& opJson : aThenOps )
        {
            for( const nlohmann::json& change :
                 opJson.value( "changes", nlohmann::json::array() ) )
            {
                SCH_COLLAB::ApplyItemChange( m_frame->Schematic(), serverScreen, change, nullptr );
            }
        }
    }

    // The sync base is this copy as it last matched the online project (see
    // the board engine for the rules); without one the online version wins.
    wxString    relPath = m_pathByDocId.count( aDocId ) ? m_pathByDocId.at( aDocId )
                                                         : wxString();
    std::string baseText = COLLAB_PROJECT::ReadSyncBase( m_frame->Prj().GetProjectPath(),
                                                         m_frame->Prj().GetProjectName(),
                                                         relPath );
    SCH_SHEET   baseSheet;
    SCH_SCREEN* baseScreen = baseText.empty() ? nullptr : loadTemp( baseText, baseSheet );
    const bool  haveBase = baseScreen != nullptr;

    auto collect = []( SCH_SCREEN* aScreen, std::map<KIID, SCH_ITEM*>& aOut )
    {
        for( SCH_ITEM* item : aScreen->Items() )
        {
            // ERC markers are local diagnostics, not document content.
            if( item->Type() != SCH_MARKER_T )
                aOut[ item->m_Uuid ] = item;
        }
    };

    std::map<KIID, SCH_ITEM*> serverItems, baseItems, localItems;
    collect( serverScreen, serverItems );
    collect( screen, localItems );

    if( baseScreen )
        collect( baseScreen, baseItems );

    auto upsertChange = []( SCH_ITEM* aItem, std::string aSexpr ) -> nlohmann::json
    {
        nlohmann::json change;
        change[ "id" ] = aItem->m_Uuid.AsStdString();
        change[ "kind" ] = "ADDED";
        change[ "typeName" ] = aItem->GetClass().ToStdString( wxConvUTF8 );
        change[ "sexpr" ] = std::move( aSexpr );
        return change;
    };

    auto removeChange = []( const KIID& aId ) -> nlohmann::json
    {
        nlohmann::json change;
        change[ "id" ] = aId.AsStdString();
        change[ "kind" ] = "REMOVED";
        change[ "typeName" ] = "";
        return change;
    };

    auto find = []( std::map<KIID, SCH_ITEM*>& aMap, const KIID& aId ) -> SCH_ITEM*
    {
        auto it = aMap.find( aId );
        return it == aMap.end() ? nullptr : it->second;
    };

    std::set<KIID> ids;

    for( const auto& [id, item] : localItems )  ids.insert( id );
    for( const auto& [id, item] : serverItems ) ids.insert( id );
    for( const auto& [id, item] : baseItems )   ids.insert( id );

    nlohmann::json fromOnline = nlohmann::json::array();
    nlohmann::json toOnline = nlohmann::json::array();
    int            kept = 0;
    int            conflicts = 0;

    for( const KIID& id : ids )
    {
        SCH_ITEM* L = find( localItems, id );
        SCH_ITEM* R = find( serverItems, id );
        SCH_ITEM* B = find( baseItems, id );

        std::string ls = L ? SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), screen, L )
                           : std::string();
        std::string rs = R ? SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), serverScreen, R )
                           : std::string();
        std::string bs = B ? SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), baseScreen, B )
                           : std::string();

        // An item that will not serialize cannot be compared; leave it be.
        if( ( L && ls.empty() ) || ( R && rs.empty() ) )
            continue;

        if( !haveBase )
        {
            if( L && !R )
                fromOnline.push_back( removeChange( id ) );
            else if( R && ( !L || ls != rs ) )
                fromOnline.push_back( upsertChange( R, std::move( rs ) ) );

            continue;
        }

        const bool haveB = B && !bs.empty();
        const bool localChanged = ( L != nullptr ) != haveB || ( L && ls != bs );
        const bool remoteChanged = ( R != nullptr ) != haveB || ( R && rs != bs );

        if( !localChanged && !remoteChanged )
        {
            continue;
        }
        else if( !localChanged )
        {
            if( R )
                fromOnline.push_back( upsertChange( R, std::move( rs ) ) );
            else
                fromOnline.push_back( removeChange( id ) );
        }
        else if( !remoteChanged )
        {
            if( L )
                toOnline.push_back( upsertChange( L, std::move( ls ) ) );
            else
                toOnline.push_back( removeChange( id ) );

            kept++;
        }
        else if( L && R && ls == rs )
        {
            continue;   // the same edit on both sides
        }
        else
        {
            // A deletion on either side wins; otherwise this copy, syncing
            // now, is the last writer and wins.
            conflicts++;

            if( !R )
                fromOnline.push_back( removeChange( id ) );
            else if( !L )
                toOnline.push_back( removeChange( id ) );
            else
                toOnline.push_back( upsertChange( L, std::move( ls ) ) );
        }
    }

    const size_t updated = fromOnline.size();

    if( !fromOnline.empty() )
    {
        PENDING_OP op;
        op.docId = aDocId;
        op.seq = m_lastAppliedSeq[ aDocId ];
        op.changes = std::move( fromOnline );
        applyOp( op );
    }

    if( !toOnline.empty() )
    {
        m_batch[ aDocId ] = std::move( toOnline );
        flushBatch();
    }

    writeSyncBase( aDocId );

    if( kept || conflicts )
    {
        m_frame->ShowInfoBarMsg( wxString::Format(
                _( "Merged with the online project: %zu item(s) updated from online, %d "
                   "offline change(s) kept, %d conflict(s) resolved in favour of this copy." ),
                updated, kept, conflicts ) );
    }
    else if( updated )
    {
        m_frame->ShowInfoBarMsg( wxString::Format(
                _( "Schematic synchronized with the online project (%zu item(s) updated)." ),
                updated ) );
    }

    if( m_frame->GetCanvas() )
        m_frame->GetCanvas()->Refresh();
}


void SCH_COLLAB_SYNC::writeSyncBase( const wxString& aDocId )
{
    SCH_SCREEN* screen = screenForDocId( aDocId );

    if( !screen || !m_pathByDocId.count( aDocId ) )
        return;

    SCH_SHEET* sheet = nullptr;

    for( const SCH_SHEET_PATH& path : m_frame->Schematic().Hierarchy() )
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

        COLLAB_PROJECT::WriteSyncBase( m_frame->Prj().GetProjectPath(),
                                       m_frame->Prj().GetProjectName(),
                                       m_pathByDocId.at( aDocId ), formatter.GetString() );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "sync base serialization failed: %s" ), ioe.What() );
    }
}


void SCH_COLLAB_SYNC::RefreshSyncBasesFromDisk()
{
    for( const auto& [path, docId] : m_docIdByPath )
    {
        bool inFlight = false;

        for( const auto& [opId, unacked] : m_unacked )
        {
            if( unacked.docId == docId )
            {
                inFlight = true;
                break;
            }
        }

        // Only a fully acknowledged save is the server's state.
        if( !inFlight )
        {
            COLLAB_PROJECT::RefreshSyncBaseFromDisk( m_frame->Prj().GetProjectPath(),
                                                     m_frame->Prj().GetProjectName(), path );
        }
    }
}


void SCH_COLLAB_SYNC::rollbackFromSnapshot( const wxString& aDocId,
                                             const std::string& aFileText )
{
    SCH_SCREEN* screen = screenForDocId( aDocId );

    auto pendIt = m_pendingRollback.find( aDocId );

    if( pendIt == m_pendingRollback.end() )
        return;

    std::set<KIID> ids;
    ids.swap( pendIt->second );
    m_pendingRollback.erase( pendIt );

    if( !screen || aFileText.empty() )
        return;

    // Parse the server's file the way the item applier parses fragments: the
    // snapshot is a complete kicad_sch document, which LoadContent accepts.
    SCH_SHEET tempSheet;

    // Screen object on heap is owned by the sheet (the paste-path pattern).
    SCH_SCREEN* tempScreen = new SCH_SCREEN( &m_frame->Schematic() );
    tempSheet.SetScreen( tempScreen );

    STRING_LINE_READER reader( aFileText, wxS( "collab-snapshot" ) );
    SCH_IO_KICAD_SEXPR plugin;

    try
    {
        plugin.LoadContent( reader, &tempSheet );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "rollback: snapshot parse failed: %s" ), ioe.What() );
        return;
    }

    // Synthesize one upsert (or removal) per touched item from the server's
    // state and run it through the same applier as any remote op.
    nlohmann::json changes = nlohmann::json::array();

    for( const KIID& id : ids )
    {
        SCH_ITEM* item = nullptr;

        for( SCH_ITEM* candidate : tempScreen->Items() )
        {
            if( candidate->m_Uuid == id )
            {
                item = candidate;
                break;
            }
        }

        nlohmann::json change;
        change[ "id" ] = id.AsStdString();

        if( item )
        {
            std::string sexpr =
                    SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), tempScreen, item );

            if( sexpr.empty() )
                continue;

            change[ "kind" ] = "ADDED";     // upsert: replace with server state
            change[ "typeName" ] = item->GetClass().ToStdString( wxConvUTF8 );
            change[ "sexpr" ] = std::move( sexpr );
        }
        else
        {
            // We added it, the server refused it: take it back out.
            change[ "kind" ] = "REMOVED";
            change[ "typeName" ] = "";
        }

        changes.push_back( std::move( change ) );
    }

    if( changes.empty() )
        return;

    PENDING_OP op;
    op.docId = aDocId;
    op.seq = m_lastAppliedSeq[ aDocId ];
    op.changes = std::move( changes );

    // Genuinely newer own in-flight edits re-assert over the rollback inside
    // applyOp, which is the right precedence for an editor; a viewer has none.
    applyOp( op );

    if( m_frame->GetCanvas() )
        m_frame->GetCanvas()->Refresh();
}


namespace
{
/// SCH_PLOTTER keeps its per-sheet SVG plotter protected; previews need just that.
class COLLAB_SCH_PLOTTER : public SCH_PLOTTER
{
public:
    using SCH_PLOTTER::SCH_PLOTTER;
    using SCH_PLOTTER::plotOneSheetSVG;
};
} // namespace


std::string SCH_COLLAB_SYNC::plotSheetPreviewSvg( SCH_SCREEN* aScreen )
{
    if( !aScreen || !m_frame->GetRenderSettings() )
        return std::string();

    // The editor's own colors, so the web render looks like the sheet people see.
    SCH_RENDER_SETTINGS renderSettings( *m_frame->GetRenderSettings() );

    SCH_PLOT_OPTS opts;
    opts.m_plotDrawingSheet = true;
    opts.m_blackAndWhite = false;
    opts.m_useBackgroundColor = true;

    wxString tmp = wxFileName::CreateTempFileName( wxS( "collab-sch-preview" ) );
    tmp += wxS( ".svg" );

    COLLAB_SCH_PLOTTER plotter( m_frame );
    std::string        svg;

    if( plotter.plotOneSheetSVG( tmp, aScreen, &renderSettings, opts ) )
    {
        wxFFile file( tmp, wxS( "rb" ) );

        if( file.IsOpened() )
        {
            svg.resize( file.Length() );
            file.Read( svg.data(), svg.size() );
        }
    }

    wxRemoveFile( tmp );

    return svg;
}


void SCH_COLLAB_SYNC::uploadSheetPreviews()
{
    // Sheet renders ride along for the web app: plot every registered sheet
    // on the UI thread (schematic access), upload on the worker — the server
    // has no plotter of its own.
    {
        std::vector<std::tuple<std::string, long long, std::string>> previews;
        std::set<const SCH_SCREEN*>                                  seen;

        for( const SCH_SHEET_PATH& path : m_frame->Schematic().Hierarchy() )
        {
            SCH_SCREEN* scr = path.LastScreen();
            wxString    id = scr ? docIdForScreen( scr ) : wxString();

            if( id.IsEmpty() || !seen.insert( scr ).second )
                continue;

            if( previews.size() >= 24 )
                break;

            std::string svg = plotSheetPreviewSvg( scr );

            if( !svg.empty() )
                previews.emplace_back( id.ToStdString( wxConvUTF8 ), m_lastAppliedSeq[ id ], std::move( svg ) );
        }

        if( !previews.empty() )
        {
            std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
            std::string token =
                    COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );

            COLLAB_SESSION::Get().RunAsync(
                    [server, token, previews]()
                    {
                        for( const auto& [docId, seq, svg] : previews )
                        {
                            for( bool fit : { true, false } )
                            {
                                COLLAB_REST::UploadPreview( wxString::FromUTF8( server ),
                                                            wxString::FromUTF8( token ),
                                                            wxString::FromUTF8( docId ), seq, fit,
                                                            svg );
                            }
                        }
                    } );
        }
    }
}


void SCH_COLLAB_SYNC::OnSnapshotRequest()
{
    uploadSheetPreviews();

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

        // Serialization needs the live schematic (UI thread); the upload of
        // the self-contained string does not — a slow server must not hitch
        // the editor.  Plain std::strings cross the thread boundary.
        std::string serverStd = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
        std::string token =
                COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
        std::string docIdStd = docId.ToStdString( wxConvUTF8 );
        long long   seq = m_lastAppliedSeq[ docId ];
        std::string payload = formatter.GetString();

        COLLAB_SESSION::Get().RunAsync(
                [serverStd, token, docIdStd, seq, payload]()
                {
                    COLLAB_REST::UploadSnapshot( wxString::FromUTF8( serverStd ),
                                                 wxString::FromUTF8( token ),
                                                 wxString::FromUTF8( docIdStd ), seq, payload );
                } );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "snapshot serialization failed: %s" ), ioe.What() );
    }
}


void SCH_COLLAB_SYNC::OnReset( const wxString& aDocId, long long aSeq )
{
    wxLogTrace( traceCollab, wxS( "server reset of %s to seq %lld" ), aDocId, aSeq );

    // Everything in flight for this doc predates the restored state.
    std::erase_if( m_queue,
                   [&]( const PENDING_OP& aPending )
                   {
                       return aPending.docId == aDocId;
                   } );

    std::erase_if( m_unacked,
                   [&]( const auto& aEntry )
                   {
                       return aEntry.second.docId == aDocId;
                   } );

    m_pendingRollback.erase( aDocId );

    // Pull the restored file and reconcile the open screen against it.
    m_reconcilePending.insert( aDocId );
    m_resyncPending[ aDocId ] = true;
    COLLAB_SESSION::Get().RequestResync( aDocId );

    m_frame->ShowInfoBarMsg( _( "The shared project was restored to an earlier version on "
                                "the server; synchronizing this schematic..." ) );
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
    ensureSheetDocs( aOp.docId, aOp.changes, false );
}


void SCH_COLLAB_SYNC::RegisterDoc( const wxString& aRelPath, const wxString& aDocId )
{
    m_docIdByPath[ aRelPath ] = aDocId;
    m_pathByDocId[ aDocId ] = aRelPath;
}


void SCH_COLLAB_SYNC::ensureSheetDocs( const wxString& aOpDocId, const nlohmann::json& aChanges,
                                       bool aIsAuthor )
{
    wxString projectId = COLLAB_SESSION::Get().ProjectId();

    if( projectId.IsEmpty() )
        return;

    SCH_SCREEN* screen = screenForDocId( aOpDocId );

    if( !screen )
        return;

    for( const nlohmann::json& change : aChanges )
    {
        if( !change.is_object() || change.value( "typeName", "" ) != "SCH_SHEET" )
            continue;

        std::string kind = change.value( "kind", "" );

        if( kind != "ADDED" && kind != "MODIFIED" )
            continue;

        KIID       id( wxString::FromUTF8( change.value( "id", "" ) ) );
        SCH_SHEET* sheet = nullptr;

        for( SCH_ITEM* item : screen->Items() )
        {
            if( item->m_Uuid == id && item->Type() == SCH_SHEET_T )
            {
                sheet = static_cast<SCH_SHEET*>( item );
                break;
            }
        }

        if( !sheet )
            continue;

        wxString file = sheet->GetFileName();
        file.Replace( wxS( "\\" ), wxS( "/" ) );

        if( file.IsEmpty() || m_docIdByPath.count( file )
            || !m_ensuredSheetFiles.insert( file ).second )
        {
            continue;
        }

        // Authors upload the new sheet's content as the doc's first snapshot;
        // receivers join with an empty screen and reconcile from it.
        std::string content;

        if( aIsAuthor )
        {
            for( const SCH_SHEET_PATH& path : m_frame->Schematic().Hierarchy() )
            {
                if( path.Last() != sheet )
                    continue;

                try
                {
                    STRING_FORMATTER   formatter;
                    SCH_IO_KICAD_SEXPR plugin;

                    plugin.FormatSchematicToFormatter( &formatter, path.Last(),
                                                       &m_frame->Schematic() );
                    content = formatter.GetString();
                }
                catch( const IO_ERROR& ioe )
                {
                    wxLogTrace( traceCollab, wxS( "new sheet serialization failed: %s" ),
                                ioe.What() );
                }

                break;
            }
        }

        std::shared_ptr<bool> alive = m_alive;
        std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
        std::string token = COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() )
                                    .ToStdString( wxConvUTF8 );
        std::string projectIdStd = projectId.ToStdString( wxConvUTF8 );
        std::string fileStd = file.ToStdString( wxConvUTF8 );

        COLLAB_SESSION::Get().RunAsync(
                [this, alive, server, token, projectIdStd, fileStd, content, aIsAuthor]()
                {
                    std::optional<nlohmann::json> created = COLLAB_REST::CreateDoc(
                            wxString::FromUTF8( server ), wxString::FromUTF8( token ),
                            wxString::FromUTF8( projectIdStd ),
                            wxString::FromUTF8( fileStd ) );

                    std::string docId = created ? created->value( "docId", "" ) : "";

                    if( docId.empty() )
                        return;

                    if( aIsAuthor && !content.empty() )
                    {
                        COLLAB_REST::UploadSnapshot( wxString::FromUTF8( server ),
                                                     wxString::FromUTF8( token ),
                                                     wxString::FromUTF8( docId ), 0, content );
                    }

                    wxTheApp->CallAfter(
                            [this, alive, docId, fileStd, aIsAuthor]()
                            {
                                if( !*alive )
                                    return;

                                wxString docIdWx = wxString::FromUTF8( docId );

                                RegisterDoc( wxString::FromUTF8( fileStd ), docIdWx );

                                // A receiver's fresh empty screen fills in from
                                // the join snapshot via the reconcile.
                                if( !aIsAuthor )
                                    m_reconcilePending.insert( docIdWx );

                                COLLAB_SESSION::Get().JoinDoc( docIdWx, std::nullopt,
                                                               m_adapter );

                                if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
                                {
                                    fprintf( stderr, "COLLAB sheet doc %s: %s (%s)\n",
                                             aIsAuthor ? "created" : "joined",
                                             fileStd.c_str(), docId.c_str() );
                                }
                            } );
                } );
    }
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
