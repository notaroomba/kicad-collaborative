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

#include "pcb_collab_sync.h"

#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <collab/collab_session.h>

#include <board.h>
#include <board_commit.h>
#include <board_connected_item.h>
#include <commit.h>
#include <connectivity/connectivity_data.h>
#include <diff_merge/kicad_diff_types.h>
#include <diff_merge/property_diff.h>
#include <footprint.h>
#include <pcb_plotter.h>
#include <pcb_plot_params.h>
#include <settings/color_settings.h>
#include <reporter.h>
#include <wx/ffile.h>
#include <pcb_group.h>
#include <ki_exception.h>
#include <netinfo.h>
#include <pad.h>
#include <libraries/library_manager.h>
#include <libraries/library_table.h>
#include <pcb_edit_frame.h>
#include <pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h>
#include <pcb_view.h>
#include <pgm_base.h>
#include <project.h>
#include <settings/common_settings.h>
#include <richio.h>
#include <tool/tool_manager.h>
#include <tools/pcb_selection_tool.h>
#include <undo_redo_container.h>
#include <zone.h>

#include <wx/app.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/utils.h>

using namespace KICAD_DIFF;

static const wxChar* const traceCollab = wxT( "COLLAB" );


namespace
{

/// Items that never sync: markers are local DRC state, netinfo is netlist
/// metadata (owned by schematic update flows).
bool typeSyncs( const BOARD_ITEM* aItem )
{
    return aItem->Type() != PCB_MARKER_T && aItem->Type() != PCB_NETINFO_T;
}


/// Groups and generators transfer too: their sexpr carries the item's own
/// properties, and membership travels beside it as a "groupMembers" uuid list
/// resolved against the receiving board (a lone fragment's member uuids cannot
/// resolve on the parse board).
bool typeSupportsSexprTransfer( const BOARD_ITEM* aItem )
{
    return typeSyncs( aItem );
}


/// Scoped echo-suppression flag.
struct APPLYING_REMOTE_SCOPE
{
    APPLYING_REMOTE_SCOPE( bool& aFlag ) : m_flag( aFlag ) { m_flag = true; }
    ~APPLYING_REMOTE_SCOPE() { m_flag = false; }

    bool& m_flag;
};


/// PCB_IO_KICAD_SEXPR with the output bound to an in-memory formatter (the
/// CLIPBOARD_IO pattern), using the full-fidelity board control flags so UUIDs
/// and net assignments survive — the actual clipboard path scrubs both.
class COLLAB_PCB_IO : public PCB_IO_KICAD_SEXPR
{
public:
    COLLAB_PCB_IO() : PCB_IO_KICAD_SEXPR() { m_out = &m_stringFormatter; }

    std::string FormatItem( const BOARD_ITEM* aItem )
    {
        // Everything travels wrapped in a board document, exactly like the
        // clipboard: the parser accepts only kicad_pcb or footprint at top level,
        // and a bare footprint would lack the (version) header, sending the
        // parser down its legacy-format branches.
        m_stringFormatter.Print( "(kicad_pcb (version %d) (generator \"pcbnew\")",
                                 SEXPR_BOARD_FILE_VERSION );
        Format( aItem );
        m_stringFormatter.Print( ")" );

        return m_stringFormatter.GetString();
    }

private:
    STRING_FORMATTER m_stringFormatter;
};


/// Parse a single-item s-expression fragment (bare footprint, or an item wrapped
/// in a kicad_pcb document).  UUIDs are preserved.  Returns nullptr on failure.
BOARD_ITEM* parseItemSexpr( const std::string& aSexpr, const KIID& aExpectedId )
{
    PCB_IO_KICAD_SEXPR io;
    BOARD_ITEM*        parsed = nullptr;

    try
    {
        parsed = io.Parse( wxString::FromUTF8( aSexpr ) );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "parseItemSexpr: parse failed: %s" ), ioe.What() );

        if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
        {
            fprintf( stderr, "COLLAB parseItemSexpr failed: %s\n",
                     ioe.What().ToStdString( wxConvUTF8 ).c_str() );
        }

        return nullptr;
    }
    catch( ... )
    {
        wxLogTrace( traceCollab, wxS( "parseItemSexpr: parse failed" ) );
        return nullptr;
    }

    if( !parsed )
        return nullptr;

    if( parsed->Type() != PCB_T )
        return parsed;      // a bare footprint

    // Wrapped: pull our item out of the temporary parse board.
    std::unique_ptr<BOARD> temp( static_cast<BOARD*>( parsed ) );

    BOARD_ITEM* found = temp->ResolveItem( aExpectedId, true );

    // A parsed group's resolved members (nested fragments) point into the
    // temp board; membership is rebuilt from the wire's uuid list instead.
    if( PCB_GROUP* group = dynamic_cast<PCB_GROUP*>( found ) )
        group->RemoveAll();

    if( !found || found->GetParent() != temp.get() )
    {
        wxLogTrace( traceCollab, wxS( "parseItemSexpr: %s not in parsed fragment" ),
                    aExpectedId.AsString() );
        return nullptr;
    }

    temp->Remove( found );

    // Everything resolved against the parse board dies with it: net pointers
    // (the caller re-resolves by name) and the static component class.
    if( BOARD_CONNECTED_ITEM* conn = dynamic_cast<BOARD_CONNECTED_ITEM*>( found ) )
        conn->SetNet( NETINFO_LIST::OrphanedItem() );

    if( FOOTPRINT* footprint = dynamic_cast<FOOTPRINT*>( found ) )
    {
        footprint->RunOnChildren(
                []( BOARD_ITEM* aChild )
                {
                    if( BOARD_CONNECTED_ITEM* conn = dynamic_cast<BOARD_CONNECTED_ITEM*>( aChild ) )
                        conn->SetNet( NETINFO_LIST::OrphanedItem() );
                },
                RECURSE_MODE::RECURSE );

        footprint->SetStaticComponentClass( nullptr );
    }

    found->SetParent( nullptr );

    return found;
}


/// A fragment's net reference is a bare net *number* from the sender's board;
/// re-resolve by name against the receiving board (identical for same-origin
/// boards, but names are the durable identity).  SetNet() is used directly so
/// this works whether or not the item is attached to the board yet.
void resolveNetByName( BOARD* aBoard, BOARD_ITEM* aItem, const nlohmann::json& aChange )
{
    if( !aChange.contains( "netName" ) || !aChange[ "netName" ].is_string() )
        return;

    BOARD_CONNECTED_ITEM* conn = dynamic_cast<BOARD_CONNECTED_ITEM*>( aItem );

    if( !conn )
        return;

    wxString name = wxString::FromUTF8( aChange[ "netName" ].get<std::string>() );

    if( NETINFO_ITEM* net = aBoard->FindNet( name ) )
        conn->SetNet( net );
    else
        conn->SetNet( NETINFO_LIST::OrphanedItem() );
}


/// Re-point a footprint's pad nets at the receiving board using the pad-number ->
/// net-name map the author sent (a parsed footprint's pads arrive orphaned).
void applyPadNets( BOARD* aBoard, FOOTPRINT* aFootprint, const nlohmann::json& aChange )
{
    if( !aChange.contains( "padNets" ) || !aChange[ "padNets" ].is_object() )
        return;

    const nlohmann::json& padNets = aChange[ "padNets" ];

    for( PAD* pad : aFootprint->Pads() )
    {
        std::string number = pad->GetNumber().ToStdString( wxConvUTF8 );

        if( !padNets.contains( number ) || !padNets[ number ].is_string() )
            continue;

        wxString name = wxString::FromUTF8( padNets[ number ].get<std::string>() );

        if( NETINFO_ITEM* net = aBoard->FindNet( name ) )
            pad->SetNet( net );
        else
            pad->SetNet( NETINFO_LIST::OrphanedItem() );
    }
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


std::string PCB_COLLAB::FormatItemSexpr( const BOARD_ITEM* aItem )
{
    wxCHECK( aItem, std::string() );

    COLLAB_PCB_IO io;

    try
    {
        if( aItem->Type() == PCB_ZONE_T )
        {
            // Fills are recomputed locally on each client and would dominate the
            // wire (hundreds of KB per zone); ship the outline only.
            std::unique_ptr<ZONE> clone( static_cast<ZONE*>( aItem->Clone() ) );
            clone->UnFill();
            clone->SetNeedRefill( true );

            return io.FormatItem( clone.get() );
        }

        return io.FormatItem( aItem );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "FormatItemSexpr failed: %s" ), ioe.What() );
        return std::string();
    }
}


bool PCB_COLLAB::ApplyItemChange( BOARD* aBoard, const nlohmann::json& aChange,
                                  BOARD_COMMIT* aCommit, BOARD_ITEM** aRemovedItem,
                                  KIGFX::PCB_VIEW* aView )
{
    if( !aBoard || !aChange.is_object() )
        return false;

    try
    {
        KIID        id( wxString::FromUTF8( aChange.value( "id", "" ) ) );
        std::string kind = aChange.value( "kind", "" );
        std::string sexpr = aChange.value( "sexpr", "" );

        BOARD_ITEM* item = aBoard->ResolveItem( id, true );

        // Ops address top-level board items only; a hit on a child (pad, field,
        // table cell) means a malformed or unsupported op.
        if( item && item->GetParent() && item->GetParent() != aBoard )
        {
            wxLogTrace( traceCollab, wxS( "ApplyItemChange: %s addresses a child item; skipped" ),
                        id.AsString() );
            return false;
        }

        if( kind == "REMOVED" )
        {
            if( !item )
                return true;    // already gone: delete beats concurrent modify (LWW)

            // A removed group must release its members first: their back-
            // pointers would dangle at the deleted group otherwise (IsLocked
            // walks them, and crashed on exactly that).
            if( PCB_GROUP* group = dynamic_cast<PCB_GROUP*>( item ) )
                group->RemoveAll();

            if( aCommit )
            {
                aCommit->Remove( item );

                if( aRemovedItem )
                    *aRemovedItem = item;
            }
            else
            {
                aBoard->Remove( item );
                delete item;
            }

            return true;
        }

        if( kind == "ADDED" || ( kind == "MODIFIED" && !sexpr.empty() ) )
        {
            BOARD_ITEM* fresh = parseItemSexpr( sexpr, id );

            if( !fresh )
                return false;

            if( !typeSupportsSexprTransfer( fresh ) )
            {
                wxLogTrace( traceCollab, wxS( "ApplyItemChange: %s transfer not supported yet" ),
                            fresh->GetClass() );
                delete fresh;
                return false;
            }

            if( ZONE* zone = dynamic_cast<ZONE*>( fresh ) )
                zone->SetNeedRefill( true );

            BOARD_ITEM* live = nullptr;

            if( item )
            {
                // Upsert-replace: highest seq wins wholesale.
                if( aCommit )
                    aCommit->Modify( item );

                // Old members' back-pointers must be cleared before the swap
                // hands the live item the parsed (empty) member list.
                if( PCB_GROUP* liveGroup = dynamic_cast<PCB_GROUP*>( item ) )
                    liveGroup->RemoveAll();

                // A footprint or table swap moves the child objects (pads, fields,
                // cells) into `fresh`, which is deleted below; evict the old
                // children from the view and connectivity while the item still
                // owns them, mirroring BOARD_COMMIT::Revert.  The commit push
                // re-adds the new children via connectivity->Update / view->Add.
                bool hasChildren = item->Type() == PCB_FOOTPRINT_T
                                   || item->Type() == PCB_TABLE_T;

                if( aView && hasChildren )
                    aView->Remove( item );

                if( std::shared_ptr<CONNECTIVITY_DATA> conn = aBoard->GetConnectivity() )
                    conn->Remove( item );

                // Component classes are owned by this board's manager; keep the
                // receiver's own object across the swap (the parsed copy's was
                // scrubbed with the parse board it came from).
                const COMPONENT_CLASS* prevClass = nullptr;

                if( FOOTPRINT* footprint = dynamic_cast<FOOTPRINT*>( item ) )
                    prevClass = footprint->GetStaticComponentClass();

                item->SwapItemData( fresh );

                // The swap moved the parsed (orphaned) net pointers onto the live
                // item; re-resolve against this board by name.
                resolveNetByName( aBoard, item, aChange );

                if( FOOTPRINT* footprint = dynamic_cast<FOOTPRINT*>( item ) )
                {
                    applyPadNets( aBoard, footprint, aChange );
                    footprint->SetStaticComponentClass( prevClass );
                }

                if( aView && hasChildren )
                    aView->Add( item );

                delete fresh;
                live = item;
            }
            else if( kind == "ADDED" )
            {
                resolveNetByName( aBoard, fresh, aChange );

                if( FOOTPRINT* footprint = dynamic_cast<FOOTPRINT*>( fresh ) )
                    applyPadNets( aBoard, footprint, aChange );

                if( aCommit )
                    aCommit->Add( fresh );
                else
                    aBoard->Add( fresh );

                live = fresh;
            }
            else
            {
                // Replace of an item deleted in the meantime: delete beats modify.
                delete fresh;
            }

            // Group membership travels by uuid and resolves against this
            // board; members not (yet) present are skipped, and a later
            // replace re-asserts them (LWW).
            if( live && aChange.contains( "groupMembers" ) )
            {
                if( PCB_GROUP* group = dynamic_cast<PCB_GROUP*>( live ) )
                {
                    group->RemoveAll();

                    for( const nlohmann::json& memberId :
                         aChange.value( "groupMembers", nlohmann::json::array() ) )
                    {
                        if( !memberId.is_string() )
                            continue;

                        BOARD_ITEM* member = aBoard->ResolveItem(
                                KIID( wxString::FromUTF8(
                                        memberId.get<std::string>() ) ),
                                true );

                        if( member && member != group
                            && ( !member->GetParent() || member->GetParent() == aBoard ) )
                        {
                            group->AddItem( member );
                        }
                    }
                }
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
                aCommit->Modify( item );

            // The CUSTOM path sources values from the resolution payload only, so
            // no ours/theirs/ancestor items are needed.
            ApplyPropertyResolutions( item, resolutions, nullptr, nullptr, nullptr );

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


PCB_COLLAB_SYNC::PCB_COLLAB_SYNC( PCB_EDIT_FRAME* aFrame, const wxString& aDocId ) :
        m_frame( aFrame ),
        m_docId( aDocId ),
        m_applyingRemote( false ),
        m_opCounter( 0 ),
        m_lastAppliedSeq( 0 ),
        m_resyncPending( false )
{
    m_frame->Bind( wxEVT_IDLE, &PCB_COLLAB_SYNC::onIdle, this );
}


PCB_COLLAB_SYNC::~PCB_COLLAB_SYNC()
{
    m_frame->Unbind( wxEVT_IDLE, &PCB_COLLAB_SYNC::onIdle, this );
}


size_t PCB_COLLAB_SYNC::CaptureCommitBegin( COMMIT& aCommit, int aCommitFlags )
{
    size_t count = aCommit.GetEntries().size();

    if( m_applyingRemote || !COLLAB_SESSION::Get().IsLive() )
        return count;

    // Zone fills are local derived state: every client refills for itself.
    if( aCommitFlags & ZONE_FILL_OP )
        return count;

    // Before-images (COMMIT_LINE::m_copy) are consumed during the push, so MODIFIED
    // and REMOVED must be captured now.  ADDED is deferred to CaptureCommitEnd so
    // the teardrop/connectivity entries appended mid-push ship in the same batch.
    captureEntries( aCommit, 0, count, false, true );

    return count;
}


void PCB_COLLAB_SYNC::CaptureCommitEnd( COMMIT& aCommit, size_t aPreCount, int aCommitFlags )
{
    if( m_applyingRemote || !COLLAB_SESSION::Get().IsLive() )
        return;

    if( aCommitFlags & ZONE_FILL_OP )
        return;

    size_t count = aCommit.GetEntries().size();

    captureEntries( aCommit, 0, std::min( aPreCount, count ), true, false );

    // Entries appended mid-push: teardrop removal/update and connectivity
    // side-effects.  Their before-images are already consumed, so modifies fall
    // back to whole-item replaces.
    if( count > aPreCount )
        captureEntries( aCommit, aPreCount, count, true, true );

    flushBatch();
}


void PCB_COLLAB_SYNC::captureEntries( COMMIT& aCommit, size_t aFrom, size_t aTo, bool aAdds,
                                      bool aModsAndRemoves )
{
    const std::vector<COMMIT::COMMIT_LINE>& entries = aCommit.GetEntries();

    for( size_t ii = aFrom; ii < aTo && ii < entries.size(); ++ii )
    {
        const COMMIT::COMMIT_LINE& entry = entries[ii];

        BOARD_ITEM* item = dynamic_cast<BOARD_ITEM*>( entry.m_item );
        int         changeType = entry.m_type & CHT_TYPE;

        if( !item )
            continue;

        if( changeType == CHT_ADD && !aAdds )
            continue;

        if( ( changeType == CHT_REMOVE || changeType == CHT_MODIFY ) && !aModsAndRemoves )
            continue;

        captureItem( item, dynamic_cast<BOARD_ITEM*>( entry.m_copy ), changeType );
    }
}


void PCB_COLLAB_SYNC::captureItem( BOARD_ITEM* aItem, BOARD_ITEM* aBefore, int aChangeType )
{
    if( !typeSyncs( aItem ) )
        return;

    // Child edits (a pad, field or table cell) ship as a whole-item replace of
    // their parent.  BOARD_COMMIT::undoLevelItem() already promotes staged
    // entries, so this mostly guards the undo/redo capture path.
    if( FOOTPRINT* parentFP = aItem->GetParentFootprint() )
    {
        aItem = parentFP;
        aBefore = nullptr;
        aChangeType = CHT_MODIFY;
    }
    else if( aItem->GetParent() && aItem->GetParent()->Type() == PCB_TABLE_T )
    {
        aItem = static_cast<BOARD_ITEM*>( aItem->GetParent() );
        aBefore = nullptr;
        aChangeType = CHT_MODIFY;
    }

    // One change per item per batch; a promoted footprint replace supersedes
    // any per-child duplicates.
    if( aChangeType == CHT_MODIFY && !m_batchIds.insert( aItem->m_Uuid ).second )
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
        sexpr = PCB_COLLAB::FormatItemSexpr( aItem );

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
            deltas = DiffItemProperties( aBefore, aItem );

        // Items are routinely staged without being changed (e.g. a dialog OK'd with
        // no edits); suppress those the same way the differ does, via operator==.
        if( aBefore && deltas.empty() && *aBefore == *aItem )
            return;

        if( !deltas.empty() )
        {
            change.properties = std::move( deltas );
        }
        else
        {
            // No property-level delta available (either the change isn't visible to
            // the property system or the before-image is gone): fall back to a
            // whole-item replace so the edit is not dropped.
            if( !typeSupportsSexprTransfer( aItem ) )
            {
                wxLogTrace( traceCollab, wxS( "capture: skipping delta-less modify of %s" ),
                            aItem->GetClass() );
                return;
            }

            sexpr = PCB_COLLAB::FormatItemSexpr( aItem );

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

    // Nets travel by name: the sexpr fragment only carries the sender's net
    // *number*, which is board-local.
    if( BOARD_CONNECTED_ITEM* conn = dynamic_cast<BOARD_CONNECTED_ITEM*>( aItem ) )
        wire[ "netName" ] = conn->GetNetname().ToStdString( wxConvUTF8 );

    // A parsed footprint's pads arrive with no board to resolve nets against, so
    // ship a pad-number -> net-name map alongside the payload.
    if( aItem->Type() == PCB_FOOTPRINT_T && !sexpr.empty() )
    {
        nlohmann::json padNets = nlohmann::json::object();

        for( PAD* pad : static_cast<FOOTPRINT*>( aItem )->Pads() )
            padNets[ pad->GetNumber().ToStdString( wxConvUTF8 ) ] =
                    pad->GetNetname().ToStdString( wxConvUTF8 );

        wire[ "padNets" ] = std::move( padNets );
    }

    if( !sexpr.empty() )
        wire[ "sexpr" ] = sexpr;

    // Membership travels by uuid: the sexpr's member ids are board-local
    // pointers on the receiving side and resolve there instead.
    if( PCB_GROUP* group = dynamic_cast<PCB_GROUP*>( aItem ) )
    {
        nlohmann::json members = nlohmann::json::array();

        for( EDA_ITEM* member : group->GetItems() )
            members.push_back( member->m_Uuid.AsStdString() );

        wire[ "groupMembers" ] = std::move( members );
    }

    if( !m_batch.is_array() )
        m_batch = nlohmann::json::array();

    m_batch.push_back( std::move( wire ) );
}


void PCB_COLLAB_SYNC::flushBatch()
{
    m_batchIds.clear();

    if( !m_batch.is_array() || m_batch.empty() )
        return;

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    wxString clientOpId = wxString::Format( wxS( "%s:%d" ), session.ClientId(), ++m_opCounter );

    std::optional<long long> baseSeq;

    if( m_lastAppliedSeq > 0 )
        baseSeq = m_lastAppliedSeq;

    // Journal before sending: an op that reaches the server but whose ack
    // we never see must still be replayable (the server dedups it).
    m_journal.Append( m_docId, clientOpId, m_batch );

    session.SendOp( m_docId, clientOpId, baseSeq, m_batch );

    m_unacked[ clientOpId ] = { std::move( m_batch ) };
    m_batch = nlohmann::json();
}


void PCB_COLLAB_SYNC::CaptureUndoRedo( PICKED_ITEMS_LIST* aList )
{
    if( !aList || m_applyingRemote || !COLLAB_SESSION::Get().IsLive() )
        return;

    for( unsigned ii = 0; ii < aList->GetCount(); ++ii )
    {
        UNDO_REDO   status = aList->GetPickedItemStatus( ii );
        BOARD_ITEM* item = dynamic_cast<BOARD_ITEM*>( aList->GetPickedItem( ii ) );

        if( !item )
            continue;

        switch( status )
        {
        case UNDO_REDO::DELETED:
            // Inverted status: the item was just removed from the board.
            captureItem( item, nullptr, CHT_REMOVE );
            break;

        case UNDO_REDO::NEWITEM:
            // Inverted status: the item was just re-added to the board.
            captureItem( item, nullptr, CHT_ADD );
            break;

        case UNDO_REDO::CHANGED:
            // The live item holds the restored (now authoritative) state; the link
            // holds the pre-undo image, i.e. the wire-perspective "before".
            captureItem( item, dynamic_cast<BOARD_ITEM*>( aList->GetPickedItemLink( ii ) ),
                         CHT_MODIFY );
            break;

        default:
            // PAGESETTINGS, GRID_ORIGIN, etc. are not document items.
            break;
        }
    }

    flushBatch();
}


void PCB_COLLAB_SYNC::OnRemoteOp( const nlohmann::json& aOpMsg )
{
    PENDING_OP op;
    op.seq = aOpMsg.value( "seq", 0LL );
    op.changes = aOpMsg.value( "changes", nlohmann::json::array() );

    if( aOpMsg.contains( "author" ) && aOpMsg[ "author" ].is_object() )
        op.authorClientId = wxString::FromUTF8( aOpMsg[ "author" ].value( "clientId", "" ) );

    if( op.seq <= 0 )
        return;

    m_queue.push_back( std::move( op ) );
    wxWakeUpIdle();
}


void PCB_COLLAB_SYNC::OnOpsTail( const nlohmann::json& aOpsMsg )
{
    m_resyncPending = false;

    // Anything queued before the tail is superseded by it; stale pre-tail broadcasts
    // would otherwise re-trigger gap detection and ping-pong resync requests.
    m_queue.clear();

    for( const nlohmann::json& opJson : aOpsMsg.value( "ops", nlohmann::json::array() ) )
    {
        PENDING_OP op;
        op.seq = opJson.value( "seq", 0LL );
        op.changes = opJson.value( "changes", nlohmann::json::array() );

        if( opJson.contains( "author" ) && opJson[ "author" ].is_object() )
            op.authorClientId = wxString::FromUTF8( opJson[ "author" ].value( "clientId", "" ) );

        if( op.seq > 0 )
            m_queue.push_back( std::move( op ) );
    }

    wxWakeUpIdle();
}


void PCB_COLLAB_SYNC::OnSnapshot( const nlohmann::json& aSnapshotMsg )
{
    // v1: we do not hot-load the snapshot file; the local copy of the project is
    // assumed to match the server snapshot (true for the uploader and for fresh
    // archive joins).  The full stale-file resync flow is M5.
    long long seq = aSnapshotMsg.value( "seq", 0LL );

    wxLogTrace( traceCollab, wxS( "snapshot for %s at seq %lld (file body ignored in v1)" ),
                m_docId, seq );

    if( m_lastAppliedSeq < seq )
        m_lastAppliedSeq = seq;

    COLLAB_SESSION::Get().SetAppliedSeq( m_docId, m_lastAppliedSeq );

    m_resyncPending = false;
    m_queue.clear();

    if( m_reconcilePending && aSnapshotMsg.contains( "file" ) )
    {
        // A doc reset: the server's file is the document now.  Reconcile the
        // whole board; any pending targeted rollback is subsumed.
        m_reconcilePending = false;
        m_pendingRollback.clear();
        reconcileFromSnapshot( aSnapshotMsg.value( "file", "" ) );
    }
    else if( !m_pendingRollback.empty() && aSnapshotMsg.contains( "file" ) )
    {
        // v1 does not hot-load the snapshot into the open board wholesale, but
        // a rejected own op needs its optimistic application undone: restore
        // just the touched items from the server's file.
        rollbackFromSnapshot( aSnapshotMsg.value( "file", "" ) );
    }

    // Replay the ops since the snapshot through the normal queue.
    for( const nlohmann::json& opJson : aSnapshotMsg.value( "thenOps",
                                                            nlohmann::json::array() ) )
    {
        PENDING_OP op;
        op.seq = opJson.value( "seq", 0LL );
        op.changes = opJson.value( "changes", nlohmann::json::array() );

        if( opJson.contains( "author" ) && opJson[ "author" ].is_object() )
            op.authorClientId = wxString::FromUTF8( opJson[ "author" ].value( "clientId", "" ) );

        if( op.seq > 0 )
            m_queue.push_back( std::move( op ) );
    }

    wxWakeUpIdle();
}


namespace
{
/// Net numbers are board-local (identity travels by name), so blank them out
/// before comparing serialized items across boards.
std::string normalizeNetNumbers( const std::string& aSexpr )
{
    std::string out;
    out.reserve( aSexpr.size() );

    for( size_t i = 0; i < aSexpr.size(); )
    {
        if( aSexpr.compare( i, 5, "(net " ) == 0 )
        {
            out += "(net ";
            i += 5;

            while( i < aSexpr.size() && isdigit( (unsigned char) aSexpr[i] ) )
                i++;
        }
        else
        {
            out += aSexpr[i++];
        }
    }

    return out;
}
} // anonymous namespace


void PCB_COLLAB_SYNC::reconcileFromSnapshot( const std::string& aFileText )
{
    BOARD* board = m_frame->GetBoard();

    if( !board || aFileText.empty() )
        return;

    PCB_IO_KICAD_SEXPR     io;
    std::unique_ptr<BOARD> server;

    try
    {
        BOARD_ITEM* parsed = io.Parse( wxString::FromUTF8( aFileText ) );

        if( !parsed )
            return;

        if( parsed->Type() != PCB_T )
        {
            delete parsed;
            return;
        }

        server.reset( static_cast<BOARD*>( parsed ) );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "reconcile: snapshot parse failed: %s" ), ioe.What() );
        return;
    }

    std::map<KIID, BOARD_ITEM*> serverItems;

    for( BOARD_ITEM* item : server->GetItemSet() )
    {
        if( typeSyncs( item ) )
            serverItems[ item->m_Uuid ] = item;
    }

    auto upsertChange = []( BOARD_ITEM* aItem, std::string aSexpr ) -> nlohmann::json
    {
        nlohmann::json change;
        change[ "id" ] = aItem->m_Uuid.AsStdString();
        change[ "kind" ] = "ADDED";
        change[ "typeName" ] = aItem->GetClass().ToStdString( wxConvUTF8 );
        change[ "sexpr" ] = std::move( aSexpr );

        if( PCB_GROUP* group = dynamic_cast<PCB_GROUP*>( aItem ) )
        {
            nlohmann::json members = nlohmann::json::array();

            for( EDA_ITEM* member : group->GetItems() )
                members.push_back( member->m_Uuid.AsStdString() );

            change[ "groupMembers" ] = std::move( members );
        }

        if( BOARD_CONNECTED_ITEM* conn = dynamic_cast<BOARD_CONNECTED_ITEM*>( aItem ) )
            change[ "netName" ] = conn->GetNetname().ToStdString( wxConvUTF8 );

        if( aItem->Type() == PCB_FOOTPRINT_T )
        {
            nlohmann::json padNets = nlohmann::json::object();

            for( PAD* pad : static_cast<FOOTPRINT*>( aItem )->Pads() )
                padNets[ pad->GetNumber().ToStdString( wxConvUTF8 ) ] =
                        pad->GetNetname().ToStdString( wxConvUTF8 );

            change[ "padNets" ] = std::move( padNets );
        }

        return change;
    };

    nlohmann::json changes = nlohmann::json::array();
    std::set<KIID>  localIds;
    int             kept = 0;

    for( BOARD_ITEM* local : board->GetItemSet() )
    {
        if( !typeSyncs( local ) )
            continue;

        localIds.insert( local->m_Uuid );

        auto it = serverItems.find( local->m_Uuid );

        if( it == serverItems.end() )
        {
            // The restored document does not have it.
            nlohmann::json change;
            change[ "id" ] = local->m_Uuid.AsStdString();
            change[ "kind" ] = "REMOVED";
            change[ "typeName" ] = "";
            changes.push_back( std::move( change ) );
            continue;
        }

        if( !typeSupportsSexprTransfer( it->second ) )
        {
            kept++;
            continue;
        }

        std::string localSexpr = PCB_COLLAB::FormatItemSexpr( local );
        std::string serverSexpr = PCB_COLLAB::FormatItemSexpr( it->second );

        if( localSexpr.empty() || serverSexpr.empty()
            || normalizeNetNumbers( localSexpr ) == normalizeNetNumbers( serverSexpr ) )
        {
            kept++;
            continue;
        }

        changes.push_back( upsertChange( it->second, std::move( serverSexpr ) ) );
    }

    for( auto& [id, item] : serverItems )
    {
        if( localIds.count( id ) || !typeSupportsSexprTransfer( item ) )
            continue;

        std::string sexpr = PCB_COLLAB::FormatItemSexpr( item );

        if( !sexpr.empty() )
            changes.push_back( upsertChange( item, std::move( sexpr ) ) );
    }

    wxLogTrace( traceCollab, wxS( "reconcile: %zu changes, %d unchanged" ),
                (size_t) changes.size(), kept );

    if( !changes.empty() )
    {
        PENDING_OP op;
        op.seq = m_lastAppliedSeq;
        op.changes = std::move( changes );
        applyOp( op );
    }

    if( m_frame->GetCanvas() )
        m_frame->GetCanvas()->Refresh();

    m_frame->ShowInfoBarMsg( _( "Board synchronized with the restored version." ) );
}


void PCB_COLLAB_SYNC::rollbackFromSnapshot( const std::string& aFileText )
{
    BOARD* board = m_frame->GetBoard();

    if( !board || aFileText.empty() )
        return;

    std::set<KIID> ids;
    ids.swap( m_pendingRollback );

    PCB_IO_KICAD_SEXPR     io;
    std::unique_ptr<BOARD> server;

    try
    {
        BOARD_ITEM* parsed = io.Parse( wxString::FromUTF8( aFileText ) );

        if( !parsed )
            return;

        if( parsed->Type() != PCB_T )
        {
            delete parsed;
            return;
        }

        server.reset( static_cast<BOARD*>( parsed ) );
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
        BOARD_ITEM* item = server->ResolveItem( id, true );

        // Ops address top-level items; resolving to a child means the id maps
        // differently on the server — leave it alone.
        if( item && item->GetParent() && item->GetParent() != server.get() )
            continue;

        nlohmann::json change;
        change[ "id" ] = id.AsStdString();

        if( item )
        {
            std::string sexpr = PCB_COLLAB::FormatItemSexpr( item );

            if( sexpr.empty() )
                continue;

            change[ "kind" ] = "ADDED";     // upsert: replace with server state
            change[ "typeName" ] = item->GetClass().ToStdString( wxConvUTF8 );
            change[ "sexpr" ] = std::move( sexpr );

            if( PCB_GROUP* group = dynamic_cast<PCB_GROUP*>( item ) )
            {
                nlohmann::json members = nlohmann::json::array();

                for( EDA_ITEM* member : group->GetItems() )
                    members.push_back( member->m_Uuid.AsStdString() );

                change[ "groupMembers" ] = std::move( members );
            }

            if( BOARD_CONNECTED_ITEM* conn = dynamic_cast<BOARD_CONNECTED_ITEM*>( item ) )
                change[ "netName" ] = conn->GetNetname().ToStdString( wxConvUTF8 );

            if( item->Type() == PCB_FOOTPRINT_T )
            {
                nlohmann::json padNets = nlohmann::json::object();

                for( PAD* pad : static_cast<FOOTPRINT*>( item )->Pads() )
                    padNets[ pad->GetNumber().ToStdString( wxConvUTF8 ) ] =
                            pad->GetNetname().ToStdString( wxConvUTF8 );

                change[ "padNets" ] = std::move( padNets );
            }
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
    op.seq = m_lastAppliedSeq;
    op.changes = std::move( changes );

    // Genuinely newer own in-flight edits re-assert over the rollback inside
    // applyOp, which is the right precedence for an editor; a viewer has none.
    applyOp( op );

    m_frame->GetCanvas()->Refresh();
}


void PCB_COLLAB_SYNC::OnAck( const wxString& aClientOpId, long long aSeq )
{
    auto it = m_unacked.find( aClientOpId );

    if( it == m_unacked.end() )
        return;

    // Advance lastAppliedSeq through the queue rather than directly: broadcasts of
    // earlier remote ops may still be queued, and skipping past them would drop edits.
    PENDING_OP marker;
    marker.seq = aSeq;
    marker.authorClientId = COLLAB_SESSION::Get().ClientId();

    m_queue.push_back( std::move( marker ) );
    m_ownRecent[ aSeq ] = std::move( it->second.changes );
    m_unacked.erase( it );
    m_journal.Ack( aClientOpId );

    wxWakeUpIdle();
}


void PCB_COLLAB_SYNC::OnOpRejected( const wxString& aClientOpId )
{
    auto it = m_unacked.find( aClientOpId );

    if( it == m_unacked.end() )
        return;

    // Remember which items the rejected op touched: the resync snapshot
    // below carries the server's state for them.
    if( it->second.changes.is_array() )
    {
        for( const nlohmann::json& change : it->second.changes )
        {
            if( change.is_object() )
                m_pendingRollback.insert(
                        KIID( wxString::FromUTF8( change.value( "id", "" ) ) ) );
        }
    }

    m_unacked.erase( it );

    // Rejected is as final as acked for replay purposes: the server will
    // refuse it again on every reconnect forever.
    m_journal.Ack( aClientOpId );

    // The op was applied optimistically here; a resync (snapshot + tail)
    // restores the server's version of the document.
    if( !m_resyncPending )
    {
        m_resyncPending = true;
        COLLAB_SESSION::Get().RequestResync( m_docId );
    }
}


void PCB_COLLAB_SYNC::OpenJournal( const wxString& aProjectPath, const wxString& aProjectName )
{
    // Not the schematic editor's journal file: each journal compacts from its own
    // in-memory state and would drop the other's lines.
    m_journal.Open( aProjectPath, aProjectName, wxS( "oplog-board.ndjson" ) );

    // Anything left from a previous run was never acknowledged: re-stage it so
    // the next connection replays it. The server dedups by clientOpId, so a
    // replay of something it already has is harmless.
    for( const COLLAB_JOURNAL::ENTRY& entry : m_journal.Pending() )
    {
        if( entry.docId == m_docId )
            m_unacked[ entry.clientOpId ] = { entry.changes };
    }
}


void PCB_COLLAB_SYNC::ReplayUnacked()
{
    if( m_unacked.empty() )
        return;

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( !session.IsLive() )
        return;

    wxLogTrace( traceCollab, wxS( "replaying %zu unacknowledged op(s)" ), m_unacked.size() );

    for( const auto& [clientOpId, op] : m_unacked )
        session.SendOp( m_docId, clientOpId, std::nullopt, op.changes );
}


void PCB_COLLAB_SYNC::OnSnapshotRequest()
{
    if( !m_unacked.empty() )
    {
        wxLogTrace( traceCollab, wxS( "snapshot request skipped: ops in flight for %s" ),
                    m_docId );
        return;
    }

    try
    {
        STRING_FORMATTER   formatter;
        PCB_IO_KICAD_SEXPR io;

        io.FormatBoardToFormatter( &formatter, m_frame->GetBoard(), nullptr );

        // Serialization needs the live board (UI thread); the upload of the
        // self-contained string does not — a slow server must not hitch the
        // editor.  Plain std::strings cross the thread boundary.
        std::string server = COLLAB_SESSION::ServerUrl().ToStdString( wxConvUTF8 );
        std::string token =
                COLLAB_AUTH::StoredToken( COLLAB_SESSION::ServerUrl() ).ToStdString( wxConvUTF8 );
        std::string docId = m_docId.ToStdString( wxConvUTF8 );
        long long   seq = m_lastAppliedSeq;
        std::string payload = formatter.GetString();

        // The board render rides along: editors have KiCad's real plotter,
        // so the server never needs one.  Plot on the UI thread (board
        // access), upload the self-contained bytes on the worker.
        std::string fitSvg = plotPreviewSvg( true );
        std::string pageSvg = plotPreviewSvg( false );

        COLLAB_SESSION::Get().RunAsync(
                [server, token, docId, seq, payload, fitSvg, pageSvg]()
                {
                    COLLAB_REST::UploadSnapshot( wxString::FromUTF8( server ),
                                                 wxString::FromUTF8( token ),
                                                 wxString::FromUTF8( docId ), seq, payload );

                    if( !fitSvg.empty() )
                    {
                        COLLAB_REST::UploadPreview( wxString::FromUTF8( server ),
                                                    wxString::FromUTF8( token ),
                                                    wxString::FromUTF8( docId ), seq, true,
                                                    fitSvg );
                    }

                    if( !pageSvg.empty() )
                    {
                        COLLAB_REST::UploadPreview( wxString::FromUTF8( server ),
                                                    wxString::FromUTF8( token ),
                                                    wxString::FromUTF8( docId ), seq, false,
                                                    pageSvg );
                    }
                } );
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "snapshot serialization failed: %s" ), ioe.What() );
    }
}


std::string PCB_COLLAB_SYNC::plotPreviewSvg( bool aFitPageToBoard )
{
    BOARD* board = m_frame->GetBoard();

    if( !board )
        return std::string();

    PCB_PLOT_PARAMS opts;
    opts.SetFormat( PLOT_FORMAT::SVG );
    opts.SetPlotFrameRef( false );
    opts.SetSvgFitPageToBoard( aFitPageToBoard );
    opts.SetBlackAndWhite( false );

    // Without explicit colors everything plots black; use the editor's own
    // theme so previews look like the board people actually see.
    opts.SetColorSettings( m_frame->GetColorSettings() );

    // The same layer set the CLI renderer used, so previews look identical
    // whichever side produced them.
    LSEQ layers = { F_Cu, B_Cu, Edge_Cuts, F_SilkS };

    wxString tmp = wxFileName::CreateTempFileName( wxS( "collab-preview" ) );
    tmp += wxS( ".svg" );

    PCB_PLOTTER plotter( board, &NULL_REPORTER::GetInstance(), opts );

    std::string svg;

    if( plotter.Plot( tmp, layers, LSEQ(), false, true ) )
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


void PCB_COLLAB_SYNC::OnReset( long long aSeq )
{
    wxLogTrace( traceCollab, wxS( "server reset to seq %lld" ), aSeq );

    // Everything in flight predates the restored state.
    m_queue.clear();
    m_unacked.clear();
    m_pendingRollback.clear();

    // Pull the restored file and reconcile the open board against it.
    m_reconcilePending = true;
    m_resyncPending = true;
    COLLAB_SESSION::Get().RequestResync( m_docId );

    m_frame->ShowInfoBarMsg( _( "The shared project was restored to an earlier version on "
                                "the server; synchronizing this board..." ) );
}


void PCB_COLLAB_SYNC::onIdle( wxIdleEvent& aEvent )
{
    aEvent.Skip();

    if( m_queue.empty() || m_applyingRemote )
        return;

    // Defer while the user is actively interacting: a held mouse button covers drags
    // and box selections; the IS_MOVING check covers the click-move-click move tool.
    // Interleaving a remote commit with a partially staged local edit is the
    // documented interleaved-commit crash.
    if( wxGetMouseState().LeftIsDown() )
        return;

    TOOL_MANAGER* mgr = m_frame->GetToolManager();

    if( PCB_SELECTION_TOOL* selTool = mgr->GetTool<PCB_SELECTION_TOOL>() )
    {
        for( EDA_ITEM* item : selTool->GetSelection() )
        {
            if( item->IsMoving() )
                return;
        }
    }

    // The router builds its own world snapshot at route start and commits at the
    // end; applying a remote op mid-route would desync it.
    if( TOOL_BASE* current = mgr->GetCurrentTool() )
    {
        if( current->GetName() == "pcbnew.InteractiveRouter" )
            return;
    }

    drainQueue();
}


void PCB_COLLAB_SYNC::drainQueue()
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    while( !m_queue.empty() )
    {
        PENDING_OP op = std::move( m_queue.front() );
        m_queue.pop_front();

        // Once lastApplied passes one of our own ops, every future remote op has
        // a higher seq and wins legitimately; the retained copy can go.
        while( !m_ownRecent.empty() && m_ownRecent.begin()->first <= m_lastAppliedSeq )
            m_ownRecent.erase( m_ownRecent.begin() );

        if( m_resyncPending )
            continue;   // dropped; the resync tail supersedes anything queued

        if( op.seq <= m_lastAppliedSeq )
            continue;

        if( op.seq > m_lastAppliedSeq + 1 )
        {
            wxLogTrace( traceCollab, wxS( "seq gap on %s: have %lld, got %lld; resyncing" ),
                        m_docId, m_lastAppliedSeq, op.seq );
            m_resyncPending = true;
            session.RequestResync( m_docId );
            continue;
        }

        if( !op.authorClientId.IsEmpty() && op.authorClientId == session.ClientId() )
        {
            // Our own op coming back in a tail (or an ack marker): already applied.
            m_lastAppliedSeq = op.seq;
            continue;
        }

        applyOp( op );
        m_lastAppliedSeq = op.seq;

        // Tell the session how far we have actually applied, so a reconnect
        // asks for the tail from here rather than from what merely arrived.
        session.SetAppliedSeq( m_docId, m_lastAppliedSeq );
    }
}


void PCB_COLLAB_SYNC::applyOp( const PENDING_OP& aOp )
{
    BOARD* board = m_frame->GetBoard();

    if( !board || !aOp.changes.is_array() || aOp.changes.empty() )
        return;

    APPLYING_REMOTE_SCOPE applying( m_applyingRemote );

    KIGFX::PCB_VIEW* view = nullptr;

    if( m_frame->GetCanvas() )
        view = static_cast<KIGFX::PCB_VIEW*>( m_frame->GetCanvas()->GetView() );

    BOARD_COMMIT             commit( m_frame->GetToolManager() );
    std::vector<BOARD_ITEM*> removedItems;

    // Some flows (the IPC API among them) express a move as REMOVED + ADDED of
    // the same id in one batch.  Applying both would stage the same live object
    // as both a removal and a modification in one commit — the removal wins and
    // the item is destroyed.  Collapse the pair: the ADDED alone upserts.
    std::set<std::string> reAddedIds;

    for( const nlohmann::json& change : aOp.changes )
    {
        if( change.is_object() && change.value( "kind", "" ) == "ADDED" )
            reAddedIds.insert( change.value( "id", "" ) );
    }

    // Two passes: a group change resolves member uuids against the board, so
    // members added in the same batch must land first.
    for( int pass : { 0, 1 } )
    for( const nlohmann::json& change : aOp.changes )
    {
        bool isGroup = change.is_object() && change.contains( "groupMembers" );

        if( ( pass == 1 ) != isGroup )
            continue;

        if( change.is_object() && change.value( "kind", "" ) == "REMOVED"
            && reAddedIds.count( change.value( "id", "" ) ) )
        {
            continue;
        }

        BOARD_ITEM* removedItem = nullptr;

        if( !PCB_COLLAB::ApplyItemChange( board, change, &commit, &removedItem, view )
            && wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
        {
            fprintf( stderr, "COLLAB apply failed: seq=%lld kind=%s type=%s id=%s\n", aOp.seq,
                     change.value( "kind", "?" ).c_str(), change.value( "typeName", "?" ).c_str(),
                     change.value( "id", "?" ).c_str() );
        }

        if( removedItem )
            removedItems.push_back( removedItem );
    }

    // Last-writer-wins repair: acks and broadcasts share one in-order stream, so
    // any of our ops still unacked here — and any acked with seq > this op's —
    // is provably NEWER than this remote op.  Re-assert our changes for the
    // items it touched, or a concurrent older edit would clobber ours on our
    // side only and the boards would diverge.
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

        for( int pass : { 0, 1 } )
        for( const nlohmann::json& change : aOwnChanges )
        {
            bool isGroup = change.is_object() && change.contains( "groupMembers" );

            if( ( pass == 1 ) != isGroup )
                continue;

            if( change.is_object() && change.value( "kind", "" ) == "REMOVED"
                && ownReAdded.count( change.value( "id", "" ) ) )
            {
                continue;
            }

            if( change.is_object() && remoteIds.count( change.value( "id", "" ) ) )
            {
                BOARD_ITEM* removedItem = nullptr;
                PCB_COLLAB::ApplyItemChange( board, change, &commit, &removedItem, view );

                if( removedItem )
                    removedItems.push_back( removedItem );
            }
        }
    };

    for( const auto& [ownSeq, changes] : m_ownRecent )
    {
        if( ownSeq > aOp.seq )
            reassert( changes );
    }

    for( const auto& [clientOpId, unacked] : m_unacked )
        reassert( unacked.changes );

    if( !commit.Empty() )
        commit.Push( _( "Remote Edit" ), SKIP_UNDO );

    // The push detached removed items from the board, view and selection but did not
    // free them (SKIP_UNDO).  Scrub the undo/redo stacks before freeing so a later
    // local undo cannot dereference them.
    for( BOARD_ITEM* item : removedItems )
    {
        KIID uuid = item->m_Uuid;

        m_frame->PurgeItemFromUndoRedo( uuid );
        delete item;
    }

    saveMissingLibraries( aOp.changes );
}


void PCB_COLLAB_SYNC::saveMissingLibraries( const nlohmann::json& aChanges )
{
    COMMON_SETTINGS* settings = Pgm().GetCommonSettings();

    if( !settings || !settings->m_Collab.save_missing_libraries )
        return;

    LIBRARY_MANAGER& manager = Pgm().GetLibraryManager();
    BOARD*           board = m_frame->GetBoard();

    for( const nlohmann::json& change : aChanges )
    {
        if( !change.is_object() || change.value( "typeName", "" ) != "FOOTPRINT" )
            continue;

        std::string kind = change.value( "kind", "" );

        if( kind != "ADDED" && kind != "MODIFIED" )
            continue;

        KIID        id( wxString::FromUTF8( change.value( "id", "" ) ) );
        BOARD_ITEM* item = board->ResolveItem( id, true );

        if( !item || item->Type() != PCB_FOOTPRINT_T )
            continue;

        FOOTPRINT* footprint = static_cast<FOOTPRINT*>( item );
        wxString   nickname = footprint->GetFPID().GetLibNickname();

        if( nickname.IsEmpty() || m_savedLibNicknames.count( nickname ) )
            continue;

        m_savedLibNicknames.insert( nickname );

        std::optional<LIBRARY_MANAGER_ADAPTER*> adapter =
                manager.Adapter( LIBRARY_TABLE_TYPE::FOOTPRINT );

        if( !adapter || ( *adapter )->HasLibrary( nickname ) )
            continue;

        // The library this footprint claims to come from does not exist here:
        // keep a project-local copy so the reference resolves for us too.
        wxString   sanitized = nickname;
        sanitized.Replace( wxS( "/" ), wxS( "_" ) );
        sanitized.Replace( wxS( ":" ), wxS( "_" ) );

        wxFileName dir( m_frame->Prj().GetProjectPath(), wxEmptyString );
        dir.AppendDir( settings->m_Collab.local_library_dir );
        dir.AppendDir( sanitized + wxS( ".pretty" ) );

        if( !dir.DirExists() && !wxFileName::Mkdir( dir.GetPath(), wxS_DIR_DEFAULT,
                                                    wxPATH_MKDIR_FULL ) )
            continue;

        try
        {
            PCB_IO_KICAD_SEXPR io;
            io.FootprintSave( dir.GetPath(), footprint );
        }
        catch( const IO_ERROR& ioe )
        {
            wxLogTrace( traceCollab, wxS( "saveMissingLibraries: save failed: %s" ),
                        ioe.What() );
            continue;
        }

        std::optional<LIBRARY_TABLE*> table =
                manager.Table( LIBRARY_TABLE_TYPE::FOOTPRINT, LIBRARY_TABLE_SCOPE::PROJECT );

        if( !table )
            continue;

        LIBRARY_TABLE_ROW& row = ( *table )->InsertRow();
        row.SetNickname( nickname );
        row.SetURI( wxS( "${KIPRJMOD}/" ) + settings->m_Collab.local_library_dir + wxS( "/" )
                    + sanitized + wxS( ".pretty" ) );
        row.SetType( wxS( "KiCad" ) );

        ( *table )->Save();
        manager.ReloadTables( LIBRARY_TABLE_SCOPE::PROJECT, { LIBRARY_TABLE_TYPE::FOOTPRINT } );

        wxLogTrace( traceCollab, wxS( "saved collaborator library '%s' to %s" ), nickname,
                    dir.GetPath() );
    }
}
