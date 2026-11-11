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
#include "sch_collab_tool.h"

#include <algorithm>
#include <functional>
#include <map>
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
#include <sch_group.h>
#include <tools/sch_actions.h>
#include <sch_io/kicad_sexpr/sch_io_kicad_sexpr.h>
#include <sch_io/kicad_sexpr/sch_io_kicad_sexpr_parser.h>
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
#include <view/view.h>
#include <sch_draw_panel.h>

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

/// Every schematic item transfers.  Sheets: the fragment parses without its screen, so
/// the applier preserves the live screen across an upsert and gives a brand-new sheet
/// the screen of its file (shared with any other sheet of that file).  Groups: a lone
/// fragment cannot resolve its member uuids, so the applier reads them off the
/// fragment's (members ...) list and resolves them on the receiving screen.
bool typeSupportsSexprTransfer( const SCH_ITEM* aItem )
{
    return true;
}


/// The member uuids a group fragment names: the wire's own "groupMembers" list when the
/// sender provided one (the board convention), else the fragment's (members "..." ...).
std::vector<KIID> groupMemberIds( const nlohmann::json& aChange, const std::string& aSexpr )
{
    std::vector<KIID> ids;

    if( aChange.contains( "groupMembers" ) && aChange[ "groupMembers" ].is_array() )
    {
        for( const nlohmann::json& member : aChange[ "groupMembers" ] )
        {
            if( member.is_string() )
                ids.emplace_back( wxString::FromUTF8( member.get<std::string>() ) );
        }

        return ids;
    }

    size_t pos = aSexpr.find( "(members" );

    if( pos == std::string::npos )
        return ids;

    size_t end = aSexpr.find( ')', pos );

    if( end == std::string::npos )
        return ids;

    // Member ids are quoted uuids; nothing in them needs unescaping.
    for( size_t open = aSexpr.find( '"', pos ); open != std::string::npos && open < end; )
    {
        size_t close = aSexpr.find( '"', open + 1 );

        if( close == std::string::npos || close > end )
            break;

        ids.emplace_back( wxString::FromUTF8( aSexpr.substr( open + 1, close - open - 1 ) ) );
        open = aSexpr.find( '"', close + 1 );
    }

    return ids;
}


/// Scoped echo-suppression flag.
struct APPLYING_REMOTE_SCOPE
{
    APPLYING_REMOTE_SCOPE( bool& aFlag ) : m_flag( aFlag ) { m_flag = true; }
    ~APPLYING_REMOTE_SCOPE() { m_flag = false; }

    bool& m_flag;
};


/// True when the text's first token is `kicad_sch`, i.e. a whole schematic document rather
/// than the bare item roots the clipboard (copyable-only) grammar is made of.
bool looksLikeDocument( const std::string& aText )
{
    size_t i = aText.find_first_not_of( " \t\r\n" );

    if( i == std::string::npos || aText[i] != '(' )
        return false;

    i = aText.find_first_not_of( " \t\r\n", i + 1 );

    // The token may be followed by any whitespace: KiCad 10 writes "(kicad_sch" and then a
    // newline, so testing for a space missed every file it saved.
    return i != std::string::npos && aText.compare( i, 9, "kicad_sch" ) == 0
           && i + 9 < aText.size() && ( isspace( static_cast<unsigned char>( aText[i + 9] ) )
                                        || aText[i + 9] == ')' );
}

} // namespace


bool SCH_COLLAB::ParseIntoScreen( const std::string& aText, SCH_SHEET& aSheet, wxString* aError )
{
    STRING_LINE_READER reader( aText, wxS( "collab" ) );

    try
    {
        if( looksLikeDocument( aText ) )
        {
            // A whole (kicad_sch …) file: SCH_IO_KICAD_SEXPR::LoadContent is
            // ParseSchematic( aIsCopyableOnly = true ), whose item loop has no case for the
            // kicad_sch token and throws on the very first one — which silently turned every
            // snapshot merge and every rollback into a no-op.  The full-file mode is the one
            // that reads a document.
            SCH_IO_KICAD_SEXPR_PARSER parser( &reader, nullptr, 0, &aSheet );
            parser.ParseSchematic( &aSheet, false );
        }
        else
        {
            // Bare item roots (optionally preceded by lib_symbols): the clipboard grammar,
            // which is exactly what FormatItemSexpr writes.
            SCH_IO_KICAD_SEXPR plugin;
            plugin.LoadContent( reader, &aSheet );
        }
    }
    catch( const IO_ERROR& ioe )
    {
        if( aError )
            *aError = ioe.What();

        return false;
    }
    catch( ... )
    {
        if( aError )
            *aError = wxS( "unknown parse failure" );

        return false;
    }

    return true;
}


namespace
{

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

    wxString error;

    // Fragments are bare item roots; a document wrapper is tolerated so that a client
    // still sending the old wrapped shape is understood rather than silently ignored.
    if( !SCH_COLLAB::ParseIntoScreen( aSexpr, tempSheet, &error ) )
    {
        wxLogTrace( traceCollab, wxS( "parseItemSexpr: parse failed: %s" ), error );

        if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
            fprintf( stderr, "COLLAB parseItemSexpr failed: %s\n", error.ToStdString( wxConvUTF8 ).c_str() );

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

        // The clipboard grammar stores a symbol's instance relative to the sending sheet,
        // so a symbol on that sheet arrives with the empty path.  Paste re-anchors it under
        // the destination sheet; do the same.  Left relative, the symbol has no instance
        // for the sheet it lands on: it still draws with its field text, but the next save
        // writes the bare prefix and an empty (instances) block, and its annotation is gone.
        if( aDestScreen )
        {
            if( !aSchematic.HasHierarchy() )
                aSchematic.RefreshHierarchy();

            SCH_SHEET_PATH dest = aSchematic.Hierarchy().FindSheetForScreen( aDestScreen );

            if( dest.size() > 0 )
                SCH_COLLAB::AnchorSymbolInstance( symbol, dest.Path() );
        }
    }

    // Whatever a parsed group resolved lives on the temporary screen and is about to be
    // freed; membership is rebuilt against the destination by the caller.
    if( found && found->Type() == SCH_GROUP_T )
        static_cast<SCH_GROUP*>( found )->RemoveAll();

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


/// The top-level item of aScreen with KIID aId, or nullptr.
SCH_ITEM* findInScreen( SCH_SCREEN* aScreen, const KIID& aId )
{
    for( SCH_ITEM* item : aScreen->Items() )
    {
        if( item->m_Uuid == aId )
            return item;
    }

    return nullptr;
}


/// The entry staging aItem for the change type aType (CHT_ADD/CHT_REMOVE/CHT_MODIFY), or
/// nullptr.
const COMMIT::COMMIT_LINE* stagedEntry( const SCH_COMMIT& aCommit, const EDA_ITEM* aItem,
                                        int aType )
{
    for( const COMMIT::COMMIT_LINE& entry : aCommit.GetEntries() )
    {
        if( entry.m_item == aItem && ( entry.m_type & CHT_TYPE ) == aType )
            return &entry;
    }

    return nullptr;
}


/// The entry staging the add of an item with KIID aId, or nullptr.
const COMMIT::COMMIT_LINE* stagedAddOf( const SCH_COMMIT& aCommit, const KIID& aId )
{
    for( const COMMIT::COMMIT_LINE& entry : aCommit.GetEntries() )
    {
        if( ( entry.m_type & CHT_TYPE ) == CHT_ADD && entry.m_item
            && entry.m_item->m_Uuid == aId )
        {
            return &entry;
        }
    }

    return nullptr;
}


/// The absolute file a sheet names, resolved the way KiCad does: against the directory of
/// the sheet that holds it.
wxFileName sheetFileOf( const SCH_SHEET* aSheet, const SCH_SCREEN* aParentScreen )
{
    wxFileName fn( aSheet->GetFileName() );

    if( fn.IsRelative() && aParentScreen && !aParentScreen->GetFileName().IsEmpty() )
        fn.MakeAbsolute( wxFileName( aParentScreen->GetFileName() ).GetPath() );

    return fn;
}


/**
 * Give a sheet that just arrived the screen of its file.
 *
 * A file that is already open somewhere in the hierarchy is *shared*: every sheet of one
 * file shows one screen, which is what makes an edit inside it appear in all of them.
 * Handing each new sheet an empty screen of its own instead left a second instance of a
 * sheet blank for good -- its file already had a document, so nothing ever filled it.
 * Only a file nobody has open gets a new, empty screen (the caller fills it from the
 * server).
 *
 * @return false when the sheet would contain itself (its file is the file of the sheet it
 *         sits on, or of one of that sheet's ancestors); nothing is attached then.
 */
bool attachSheetScreen( SCHEMATIC& aSchematic, SCH_SCREEN* aParentScreen, SCH_SHEET* aSheet )
{
    const wxFileName file = sheetFileOf( aSheet, aParentScreen );
    SCH_SCREEN*      shared = nullptr;

    for( const SCH_SHEET_PATH& path : aSchematic.Hierarchy() )
    {
        SCH_SCREEN* screen = path.LastScreen();

        if( !screen || screen->GetFileName().IsEmpty() )
            continue;

        wxFileName candidate( screen->GetFileName() );

        if( candidate.IsRelative() != file.IsRelative() ? candidate.GetFullName() == file.GetFullName()
                                                        : candidate == file )
        {
            shared = screen;
            break;
        }
    }

    if( shared )
    {
        // Recursion: the shared screen is the one this sheet sits on, or shows above it.
        for( const SCH_SHEET_PATH& path : aSchematic.Hierarchy() )
        {
            if( path.LastScreen() != aParentScreen )
                continue;

            for( size_t ii = 0; ii < path.size(); ++ii )
            {
                if( path.at( ii )->GetScreen() == shared )
                    return false;
            }
        }

        aSheet->SetScreen( shared );
        return true;
    }

    SCH_SCREEN* newScreen = new SCH_SCREEN( &aSchematic );

    newScreen->SetFileName( file.IsAbsolute() ? file.GetFullPath() : aSheet->GetFileName() );
    aSheet->SetScreen( newScreen );
    return true;
}


/// Every symbol gets an instance for every sheet path that shows it.  A sheet that arrives
/// sharing a screen adds paths to symbols that were already there; without an instance for
/// the new path they draw with a bare reference and lose their annotation on save.  An
/// existing instance is never touched.
void addMissingSymbolInstances( SCHEMATIC& aSchematic )
{
    for( const SCH_SHEET_PATH& path : aSchematic.Hierarchy() )
    {
        SCH_SCREEN* screen = path.LastScreen();

        if( !screen )
            continue;

        for( SCH_ITEM* item : screen->Items().OfType( SCH_SYMBOL_T ) )
        {
            SCH_SYMBOL*         symbol = static_cast<SCH_SYMBOL*>( item );
            SCH_SYMBOL_INSTANCE instance;

            if( symbol->GetInstances().empty() || symbol->GetInstance( instance, path.Path() ) )
                continue;

            instance = symbol->GetInstances().front();
            instance.m_Path = path.Path();
            symbol->AddHierarchicalReference( instance );
        }
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


wxString SCH_COLLAB::ResolveProjectId( const nlohmann::json& aProject, const wxString& aCurrentId )
{
    if( !aProject.is_object() || !aProject.contains( "projectId" ) )
        return aCurrentId;

    return wxString::FromUTF8( aProject.value( "projectId", "" ) );
}


long long SCH_COLLAB::ResolveOwnerId( const nlohmann::json& aProject, long long aCurrentOwnerId )
{
    if( !aProject.is_object() || !aProject.contains( "ownerId" ) )
        return aCurrentOwnerId;

    return aProject.value( "ownerId", 0LL );
}


std::string SCH_COLLAB::FormatItemSexpr( SCHEMATIC& aSchematic, SCH_SCREEN* aScreen,
                                         SCH_ITEM* aItem, const SCH_SHEET_PATH* aSheetPath )
{
    wxCHECK( aItem, std::string() );

    SCH_SELECTION selection( aScreen );
    selection.Add( aItem );

    if( !aSchematic.HasHierarchy() )
        aSchematic.RefreshHierarchy();

    SCH_SHEET_LIST hierarchy = aSchematic.Hierarchy();
    SCH_SHEET_PATH path = aSheetPath ? *aSheetPath : hierarchy.FindSheetForScreen( aScreen );

    // A scratch screen (a snapshot or sync base being compared, a fold of pending ops) is
    // outside the hierarchy.  With no sheet path the clipboard writer emits symbol
    // instances with their absolute paths, while the live copy of the same symbol emits
    // the path relative to its sheet (empty): the two compared unequal and every join
    // re-sent every symbol as an upsert.  Stand in the sheet whose file the screen holds.
    if( path.size() == 0 && aScreen && !aScreen->GetFileName().IsEmpty() )
    {
        for( const SCH_SHEET_PATH& candidate : hierarchy )
        {
            SCH_SCREEN* live = candidate.LastScreen();

            if( live && live->GetFileName() == aScreen->GetFileName() )
            {
                path = candidate;
                break;
            }
        }
    }

    STRING_FORMATTER   formatter;
    SCH_IO_KICAD_SEXPR plugin;

    // aForClipboard preserves UUIDs and instance data; this is exactly the string
    // SCH_EDITOR_CONTROL::doCopy() puts on the clipboard for one item.
    plugin.Format( &selection, &path, aSchematic, &formatter, true );

    return formatter.GetString();
}


void SCH_COLLAB::AnchorSymbolInstance( SCH_SYMBOL* aSymbol, const KIID_PATH& aSheetPath )
{
    SCH_SYMBOL_INSTANCE anchored;

    if( !aSymbol || aSheetPath.empty() || aSymbol->GetInstance( anchored, aSheetPath ) )
        return;

    const std::vector<SCH_SYMBOL_INSTANCE> instances = aSymbol->GetInstances();
    const SCH_SYMBOL_INSTANCE*             relative = nullptr;

    for( const SCH_SYMBOL_INSTANCE& instance : instances )
    {
        if( instance.m_Path.empty() )
        {
            relative = &instance;
            break;
        }
    }

    // A sender that serialised against no sheet path wrote its absolute path instead;
    // with one instance that is still this sheet's.
    if( !relative && instances.size() == 1 )
        relative = &instances.front();

    if( !relative )
        return;

    anchored = *relative;
    anchored.m_Path = aSheetPath;
    aSymbol->RemoveInstance( relative->m_Path );
    aSymbol->AddHierarchicalReference( anchored );
}


void SCH_COLLAB::StripDerivedDeltas( const SCH_ITEM* aItem,
                                     std::vector<KICAD_DIFF::PROPERTY_DELTA>& aDeltas )
{
    if( !aItem || aDeltas.empty() )
        return;

    // A wire's Length is its start-to-end distance, but SCH_LINE::SetLength() rescales the
    // end along the line's *current* direction.  A drag that slides a wire sideways ships
    // "End X", "End Y", "Length", "Start X" in that order; applied literally, Length ran
    // against the half-updated diagonal and left the end a few hundred units off grid, so
    // the wire missed its pin and drew as a slanted stub on every other client.
    static const std::map<KICAD_T, std::set<wxString>> derived = {
        { SCH_LINE_T, { wxS( "Length" ) } },
    };

    auto it = derived.find( aItem->Type() );

    if( it == derived.end() )
        return;

    const std::set<wxString>& names = it->second;

    aDeltas.erase( std::remove_if( aDeltas.begin(), aDeltas.end(),
                                   [&]( const KICAD_DIFF::PROPERTY_DELTA& aDelta )
                                   {
                                       return names.count( aDelta.name ) > 0;
                                   } ),
                   aDeltas.end() );
}


bool SCH_COLLAB::ApplyItemChange( SCHEMATIC& aSchematic, SCH_SCREEN* aScreen,
                                  const nlohmann::json& aChange, SCH_COMMIT* aCommit,
                                  bool aResolveInScreen )
{
    if( !aChange.is_object() )
        return false;

    if( aResolveInScreen && !aScreen )
        return false;

    try
    {
        KIID        id( wxString::FromUTF8( aChange.value( "id", "" ) ) );
        std::string kind = aChange.value( "kind", "" );
        std::string sexpr = aChange.value( "sexpr", "" );

        if( !aSchematic.HasHierarchy() )
            aSchematic.RefreshHierarchy();

        SCH_ITEM* item = aResolveInScreen ? findInScreen( aScreen, id )
                                          : aSchematic.ResolveItem( id, nullptr, true );

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
            {
                // Not on the sheet, but about to be: an add staged earlier in this same
                // commit (someone's concurrent re-add, overtaken by this deletion).  Drop
                // the add rather than let the push revive what was just deleted.
                if( aCommit )
                {
                    if( const COMMIT::COMMIT_LINE* add = stagedAddOf( *aCommit, id ) )
                    {
                        EDA_ITEM*    orphan = add->m_item;
                        BASE_SCREEN* addScreen = add->m_screen;

                        // Staging the removal of a staged add cancels the add
                        // (COMMIT::Stage); the never-appended item is ours to free.
                        aCommit->Remove( orphan, addScreen );
                        delete orphan;
                    }
                }

                return true;    // already gone: delete beats concurrent modify (LWW)
            }

            // A removed group releases its members first: their back-pointers would
            // dangle at the freed group otherwise.  The members stay on the sheet.
            if( item->Type() == SCH_GROUP_T )
                static_cast<SCH_GROUP*>( item )->RemoveAll();

            if( aCommit )
            {
                // The push detaches it; ApplyRemoteOp frees what the commit ends up
                // removing -- which may not be this item, if a newer own change of it
                // is re-asserted later in the same commit.
                aCommit->Remove( item, screen );
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

            SCH_ITEM*   live = nullptr;
            SCH_SCREEN* liveScreen = nullptr;

            if( item )
            {
                live = item;
                liveScreen = screen;

                // Upsert-replace: highest seq wins wholesale.
                if( aCommit )
                    aCommit->Modify( item, screen );

                // A parsed sheet fragment has no screen; the live sheet's
                // screen (and the file contents behind it) must survive.
                SCH_SCREEN* keepScreen = nullptr;

                if( item->Type() == SCH_SHEET_T )
                    keepScreen = static_cast<SCH_SHEET*>( item )->GetScreen();

                // Old members' back-pointers are cleared before the swap hands the live
                // group the parsed (empty) member list.
                if( item->Type() == SCH_GROUP_T && fresh->Type() == SCH_GROUP_T )
                    static_cast<SCH_GROUP*>( item )->RemoveAll();

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

                        for( const std::unique_ptr<SCH_PIN>& pin : freshSymbol->GetRawPins() )
                            graph->RemoveItem( pin.get() );
                    }

                    static_cast<SCH_SYMBOL*>( item )->UpdatePins();
                }

                delete fresh;

                if( !aCommit && screen )
                    screen->Update( item );
            }
            else if( kind == "ADDED" )
            {
                if( fresh->Type() == SCH_SHEET_T
                    && !attachSheetScreen( aSchematic, aScreen, static_cast<SCH_SHEET*>( fresh ) ) )
                {
                    wxLogTrace( traceCollab, wxS( "ApplyItemChange: sheet %s would contain itself" ),
                                id.AsString() );
                    delete fresh;
                    return false;
                }

                live = fresh;
                liveScreen = aScreen;

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

            // Group membership resolves against the sheet the group lands on.  Members
            // added by this same commit are staged, not on the sheet yet; members that are
            // nowhere are skipped, and a later replace re-asserts them (LWW).
            if( live && live->Type() == SCH_GROUP_T )
            {
                SCH_GROUP* group = static_cast<SCH_GROUP*>( live );

                group->RemoveAll();

                for( const KIID& memberId : groupMemberIds( aChange, sexpr ) )
                {
                    SCH_ITEM* member = liveScreen ? findInScreen( liveScreen, memberId ) : nullptr;

                    if( !member && aCommit )
                    {
                        if( const COMMIT::COMMIT_LINE* add = stagedAddOf( *aCommit, memberId ) )
                            member = dynamic_cast<SCH_ITEM*>( add->m_item );
                    }

                    if( member && member != live )
                        group->AddItem( member );
                }
            }

            return true;
        }

        if( kind == "MODIFIED" )
        {
            if( !item )
                return true;    // deleted concurrently: no-op (LWW)

            // Staged for removal in this very commit: the deletion wins here too, as it
            // does on every other client, where the same property edit finds no item.
            if( aCommit && stagedEntry( *aCommit, item, CHT_REMOVE ) )
                return true;

            std::vector<PROPERTY_DELTA> deltas;

            for( const nlohmann::json& propJson : aChange.value( "properties",
                                                                 nlohmann::json::array() ) )
            {
                deltas.push_back( PROPERTY_DELTA::FromJson( propJson ) );
            }

            // Clients that predate the sender-side strip still send derived deltas.
            SCH_COLLAB::StripDerivedDeltas( item, deltas );

            std::vector<PROPERTY_RESOLUTION> resolutions;

            for( const PROPERTY_DELTA& delta : deltas )
            {
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


void SCH_COLLAB::ApplyRemoteOp( SCHEMATIC& aSchematic, SCH_SCREEN* aScreen,
                                const nlohmann::json& aChanges,
                                const std::vector<const nlohmann::json*>& aNewerOwnChanges,
                                TOOL_MANAGER* aToolMgr,
                                const std::function<void( SCH_ITEM* )>& aBeforeFree )
{
    SCH_COMMIT commit( aToolMgr );
    bool       sheetArrived = false;

    // Stage one change list.  A REMOVED + ADDED pair for the same id in one list would
    // stage the same live object as both a removal and a modification -- the removal
    // wins and the item is destroyed.  Collapse: the ADDED alone upserts.
    auto stage = [&]( const nlohmann::json& aList, const std::set<std::string>* aOnlyIds )
    {
        if( !aList.is_array() )
            return;

        std::set<std::string> reAdded;

        for( const nlohmann::json& change : aList )
        {
            if( change.is_object() && change.value( "kind", "" ) == "ADDED" )
                reAdded.insert( change.value( "id", "" ) );
        }

        // A group resolves its members on the sheet, so whatever else the list adds lands
        // first, and a group that is a member of another lands before the one holding it.
        std::vector<const nlohmann::json*> ordered;
        std::vector<const nlohmann::json*> groups;

        for( const nlohmann::json& change : aList )
        {
            if( !change.is_object() )
                continue;

            if( change.value( "typeName", "" ) == "SCH_GROUP" || change.contains( "groupMembers" ) )
                groups.push_back( &change );
            else
                ordered.push_back( &change );
        }

        while( !groups.empty() )
        {
            size_t pick = 0;

            for( size_t ii = 0; ii < groups.size(); ++ii )
            {
                bool holdsPending = false;

                for( const KIID& member :
                     groupMemberIds( *groups[ii], groups[ii]->value( "sexpr", "" ) ) )
                {
                    for( size_t jj = 0; jj < groups.size(); ++jj )
                    {
                        if( jj != ii && groups[jj]->value( "id", "" ) == member.AsStdString() )
                            holdsPending = true;
                    }
                }

                if( !holdsPending )
                {
                    pick = ii;
                    break;
                }
            }

            ordered.push_back( groups[pick] );
            groups.erase( groups.begin() + pick );
        }

        {
            for( const nlohmann::json* changePtr : ordered )
            {
                const nlohmann::json& change = *changePtr;
                const std::string     type = change.value( "typeName", "" );

                std::string id = change.value( "id", "" );

                if( change.value( "kind", "" ) == "REMOVED" && reAdded.count( id ) )
                    continue;

                if( aOnlyIds && !aOnlyIds->count( id ) )
                    continue;

                if( ApplyItemChange( aSchematic, aScreen, change, &commit ) && type == "SCH_SHEET"
                    && change.value( "kind", "" ) != "REMOVED" )
                {
                    sheetArrived = true;
                }
            }
        }
    };

    stage( aChanges, nullptr );

    // Last-writer-wins repair: every own change list here is provably NEWER than this op.
    // Re-assert it over the items the op touched, or a concurrent older edit would
    // clobber ours on our side only and the documents would diverge.  Oldest first, so
    // where two own edits touch one item the later one is what stands.
    std::set<std::string> remoteIds;

    if( aChanges.is_array() )
    {
        for( const nlohmann::json& change : aChanges )
        {
            if( change.is_object() )
                remoteIds.insert( change.value( "id", "" ) );
        }
    }

    for( const nlohmann::json* own : aNewerOwnChanges )
    {
        if( own )
            stage( *own, &remoteIds );
    }

    // What the push will detach is what the commit ends up staging as a removal -- not
    // what was asked for along the way: a re-asserted own upsert turns a staged removal
    // back into a modification and the item stays on the sheet, and the same item can be
    // asked for twice.  Freeing by request left freed items in the screen's RTree, and
    // the next sheet plot walked them.
    std::vector<std::pair<SCH_ITEM*, SCH_SCREEN*>> detached;

    for( const COMMIT::COMMIT_LINE& entry : commit.GetEntries() )
    {
        if( ( entry.m_type & CHT_TYPE ) != CHT_REMOVE )
            continue;

        SCH_ITEM* item = dynamic_cast<SCH_ITEM*>( entry.m_item );

        if( !item )
            continue;

        bool seen = std::any_of( detached.begin(), detached.end(),
                                 [&]( const auto& aPair ) { return aPair.first == item; } );

        if( !seen )
            detached.emplace_back( item, dynamic_cast<SCH_SCREEN*>( entry.m_screen ) );
    }

    if( !commit.Empty() )
        commit.Push( _( "Remote Edit" ), SKIP_UNDO | SKIP_CLEANUP );

    // A sheet that arrived may show screens that were already open under new paths.
    if( sheetArrived )
    {
        aSchematic.RefreshHierarchy();
        addMissingSymbolInstances( aSchematic );
    }

    for( const auto& [item, screen] : detached )
    {
        // The push detached removed items from the screen, view and selection but did
        // not free them (SKIP_UNDO).  One it left on its screen after all is not ours to
        // free: a freed item still in the RTree is a crash in waiting.
        if( screen && screen->CheckIfOnDrawList( item ) )
        {
            wxLogTrace( traceCollab, wxS( "ApplyRemoteOp: %s still on its screen; not freed" ),
                        item->m_Uuid.AsString() );
            continue;
        }

        if( aBeforeFree )
            aBeforeFree( item );

        delete item;
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


wxString SCH_COLLAB_SYNC::relPathForSheet( const SCH_SCREEN* aParentScreen,
                                           const SCH_SHEET* aSheet ) const
{
    if( !aSheet )
        return wxEmptyString;

    // Once the sheet has its own screen that screen's file name is already resolved.
    if( aSheet->GetScreen() && !aSheet->GetScreen()->GetFileName().IsEmpty() )
        return relPathForScreen( aSheet->GetScreen() );

    // Otherwise resolve it the way KiCad does: a sheet's file name is relative to the sheet
    // that holds it, not to the project root.  Registering the raw name instead means a sheet
    // one directory down registers as "power.kicad_sch" while its screen reports
    // "sub/power.kicad_sch", and screenForDocId() never matches it again.
    wxFileName fn( aSheet->GetFileName() );

    if( fn.IsRelative() && aParentScreen )
        fn.MakeAbsolute( wxFileName( aParentScreen->GetFileName() ).GetPath() );

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

    // Captured whether or not the connection is up: an edit made while it is down waits
    // in the outbox and goes out when it returns.
    if( m_applyingRemote )
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
    CaptureCommitPhase( aCommit, aPreCount );
    FlushCommitCapture();
}


void SCH_COLLAB_SYNC::FlushCommitCapture()
{
    if( m_applyingRemote )
        return;

    flushBatch();
}


void SCH_COLLAB_SYNC::CaptureCommitPhase( COMMIT& aCommit, size_t aPreCount )
{
    if( m_applyingRemote )
        return;

    size_t count = aCommit.GetEntries().size();

    captureEntries( aCommit, 0, std::min( aPreCount, count ), true, false );

    // Entries appended mid-push: connectivity-derived CHT_DONE adds/removes from
    // SCHEMATIC::CleanUp, plus group modifications staged inside pushSchEdit (whose
    // before-images are already consumed).
    if( count > aPreCount )
        captureEntries( aCommit, aPreCount, count, true, true );
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

        // A group's membership is invisible to the property system: a group always
        // ships whole, or a rename would travel and the members added with it would not.
        if( aItem->Type() == SCH_GROUP_T )
            aBefore = nullptr;

        if( aBefore )
        {
            // Property enumeration on symbols resolves against the current sheet.
            SCH_SHEET_LIST hierarchy = m_frame->Schematic().Hierarchy();
            SCH_SHEET_PATH path = hierarchy.FindSheetForScreen( aScreen );
            SHEET_SCOPE    scope( &m_frame->Schematic(), &path );

            deltas = DiffItemProperties( aBefore, aItem );
            SCH_COLLAB::StripDerivedDeltas( aItem, deltas );
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

        // Queued before sending: an op that reaches the server but whose ack we never
        // see must still be replayable (the server dedups it), and one made while the
        // connection is down has nowhere else to wait.
        m_outbox.Push( docId, clientOpId, std::move( changes ) );

        if( !session.IsLive() )
            m_offlineEdits++;
    }

    m_batch.clear();

    pump();
}


void SCH_COLLAB_SYNC::pump()
{
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    if( !session.IsLive() )
        return;

    m_outbox.Pump(
            [&]( const COLLAB_OUTBOX::OP& aOp )
            {
                // Not before the catch-up of this connection has arrived for the op's
                // document: what it holds decides whether the waiting ops are replayed
                // (an ops tail) or folded into a merge (a snapshot).
                if( !m_caughtUp.count( aOp.docId ) )
                    return false;

                std::optional<long long> baseSeq;
                auto                     seqIt = m_lastAppliedSeq.find( aOp.docId );

                if( seqIt != m_lastAppliedSeq.end() )
                    baseSeq = seqIt->second;

                return session.SendOp( aOp.docId, aOp.clientOpId, baseSeq, aOp.changes );
            } );
}


void SCH_COLLAB_SYNC::OnConnectionChanged( bool aLive )
{
    if( aLive )
    {
        // Sheets added while the server was out of reach have no document yet.
        retrySheetDocs();
        return;
    }

    // Each sheet as it stands is the last state this editor and the server agreed on
    // (give or take the ops still in the outbox, which the merge treats as local
    // whatever the base says).  If the server has let go of the ops we miss by the time
    // we are back, these are the bases of the merge: against the files on disk, every
    // edit made online since the last save would read as an offline one and beat
    // whatever a collaborator did to the same item in the meantime.
    for( const wxString& docId : m_caughtUp )
    {
        std::string text = formatDoc( docId );

        if( !text.empty() )
            m_offlineBase[ docId ] = std::move( text );
    }

    m_caughtUp.clear();
    m_outbox.MarkAllUnsent();

    if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
        fprintf( stderr, "COLLAB offline: connection lost, %zu op(s) waiting\n", m_outbox.Size() );
}


void SCH_COLLAB_SYNC::caughtUp( const wxString& aDocId )
{
    m_caughtUp.insert( aDocId );
    m_offlineBase.erase( aDocId );
    pump();
}


void SCH_COLLAB_SYNC::CaptureUndoRedo( PICKED_ITEMS_LIST* aList )
{
    if( !aList || m_applyingRemote )
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

    // Caught up by replaying what we missed: the ops waiting here are newer than all of
    // it (applyOp re-asserts them over each one), so they simply go out now.
    caughtUp( docId );

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

        // What the server refused goes back to the server's version, whatever the base
        // says about it.
        std::set<KIID> refused;

        if( auto pendIt = m_pendingRollback.find( docId ); pendIt != m_pendingRollback.end() )
        {
            refused.swap( pendIt->second );
            m_pendingRollback.erase( pendIt );
        }

        // Everything still in the outbox is an edit made here that the snapshot may not
        // hold.  The ones not on the wire are not replayed on top of the merge: the
        // merge publishes the state they left instead, with a deletion made online in
        // the meantime winning as it does everywhere else.
        std::set<std::string> ownIds = m_outbox.TouchedIds( docId );
        size_t                folded = m_outbox.TakeUnsent( docId ).size();

        m_offlineEdits -= std::min( m_offlineEdits, folded );

        reconcileFromSnapshot( docId, aSnapshotMsg.value( "file", "" ), thenOps, ownIds,
                               refused );
        caughtUp( docId );
    }
    else
    {
        caughtUp( docId );

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
    COLLAB_OUTBOX::OP acked;

    if( !m_outbox.Ack( aClientOpId, &acked ) )
        return;

    // Advance lastAppliedSeq through the queue rather than directly: broadcasts of
    // earlier remote ops may still be queued, and skipping past them would drop edits.
    PENDING_OP marker;
    marker.docId = acked.docId;
    marker.seq = aSeq;
    marker.authorClientId = COLLAB_SESSION::Get().ClientId();

    m_queue.push_back( std::move( marker ) );
    m_ownRecent[ acked.docId ][ aSeq ] = std::move( acked.changes );

    // A merge pushed changes of this document; with the last of them acknowledged the
    // file on disk is its sync base.
    if( m_baseRefreshAfterMerge.count( acked.docId ) && m_outbox.Count( acked.docId ) == 0 )
        refreshBaseAfterMerge( acked.docId );

    if( m_outbox.Empty() )
    {
        if( m_baseRefreshWanted && !m_frame->IsContentModified() )
        {
            m_baseRefreshWanted = false;
            RefreshSyncBasesFromDisk();
        }

        if( m_offlineEdits > 0 )
        {
            if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
                fprintf( stderr, "COLLAB online: %zu offline op(s) sent\n", m_offlineEdits );

            m_frame->ShowInfoBarMsg( wxString::Format(
                    wxPLURAL( "Back online: %zu edit made while offline was sent.",
                              "Back online: %zu edits made while offline were sent.",
                              m_offlineEdits ),
                    m_offlineEdits ) );
            m_offlineEdits = 0;
        }
    }

    // The window has room again.
    pump();

    wxWakeUpIdle();
}


void SCH_COLLAB_SYNC::OnOpRejected( const wxString& aClientOpId )
{
    COLLAB_OUTBOX::OP refused;

    // Rejected is as final as acked for replay purposes: the server will
    // refuse it again on every reconnect forever.
    if( !m_outbox.Ack( aClientOpId, &refused ) )
        return;

    wxString docId = refused.docId;

    // Remember which items the rejected op touched: the resync snapshot
    // below carries the server's state for them.
    if( refused.changes.is_array() )
    {
        for( const nlohmann::json& change : refused.changes )
        {
            if( change.is_object() )
                m_pendingRollback[ docId ].insert(
                        KIID( wxString::FromUTF8( change.value( "id", "" ) ) ) );
        }
    }

    if( m_offlineEdits > 0 )
        m_offlineEdits--;

    // The op was applied optimistically here; a resync (snapshot + tail)
    // restores the server's version of the document.
    if( !m_resyncPending[ docId ] )
    {
        m_resyncPending[ docId ] = true;
        COLLAB_SESSION::Get().RequestResync( docId );
    }

    pump();
}


void SCH_COLLAB_SYNC::reconcileFromSnapshot( const wxString& aDocId,
                                             const std::string& aFileText,
                                             const nlohmann::json& aThenOps,
                                             const std::set<std::string>& aOwnIds,
                                             const std::set<KIID>& aRefusedIds )
{
    SCH_SCREEN* screen = screenForDocId( aDocId );

    if( !screen || aFileText.empty() )
        return;

    // Screen objects on the heap are owned by their sheet (the paste-path pattern).
    auto loadTemp = [this]( const std::string& aText, SCH_SHEET& aSheet ) -> SCH_SCREEN*
    {
        SCH_SCREEN* tempScreen = new SCH_SCREEN( &m_frame->Schematic() );
        aSheet.SetScreen( tempScreen );

        wxString error;

        // The snapshot is a whole kicad_sch document, so it needs the full-file parse; the
        // copyable-only loader this used to call rejects the leading (kicad_sch, which made
        // the merge — the thing that heals a stale copy on join — a silent no-op.
        if( !SCH_COLLAB::ParseIntoScreen( aText, aSheet, &error ) )
        {
            wxLogTrace( traceCollab, wxS( "reconcile: parse failed: %s" ), error );

            if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
                fprintf( stderr, "COLLAB reconcile parse failed: %s\n", error.ToStdString( wxConvUTF8 ).c_str() );

            return nullptr;
        }

        return tempScreen;
    };

    SCH_SHEET   serverSheet;
    SCH_SCREEN* serverScreen = loadTemp( aFileText, serverSheet );

    if( !serverScreen )
        return;

    // The server's truth is the snapshot plus every op since it; fold those in
    // headlessly so the merge sees one consistent online state.  Resolve within the
    // scratch screen only: the hierarchy lookup found the live items of the same KIIDs
    // and applied the server's ops to the open sheet instead -- deleting live items
    // behind the view's back, and leaving the scratch copy without the deletions so the
    // merge then resurrected what the server had removed.
    if( aThenOps.is_array() )
    {
        for( const nlohmann::json& opJson : aThenOps )
        {
            for( const nlohmann::json& change :
                 opJson.value( "changes", nlohmann::json::array() ) )
            {
                SCH_COLLAB::ApplyItemChange( m_frame->Schematic(), serverScreen, change, nullptr,
                                             true );
            }
        }
    }

    // The sync base is this copy as it last matched the online project (see
    // the board engine for the rules); without one the online version wins.
    wxString    relPath = m_pathByDocId.count( aDocId ) ? m_pathByDocId.at( aDocId )
                                                         : wxString();
    std::string baseText;

    // After a connection lost mid-session the base is the sheet as it was when the
    // connection went (see OnConnectionChanged), not the file on disk.
    bool memoryBase = false;

    if( auto baseIt = m_offlineBase.find( aDocId ); baseIt != m_offlineBase.end() )
    {
        baseText = baseIt->second;
        memoryBase = !baseText.empty();
    }

    if( baseText.empty() )
    {
        baseText = COLLAB_PROJECT::ReadSyncBase( m_frame->Prj().GetProjectPath(),
                                                 m_frame->Prj().GetProjectName(), relPath );
    }

    // A screen that was just rebuilt empty (see ensureSheetDocs) has nothing of its own to
    // merge: measured against the base, its emptiness would read as "this user deleted
    // everything" and be sent to the server as exactly that.  The online version wins.
    if( m_takeServer.erase( aDocId ) )
        baseText.clear();

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

    // The snapshot and base screens are scratch copies outside the hierarchy: serialise
    // all three against the live sheet, or a symbol's instance path differs between them
    // (absolute vs. relative) and an untouched symbol counts as an offline edit on every
    // join, re-sent as an upsert that strips the other clients' annotation.
    if( !m_frame->Schematic().HasHierarchy() )
        m_frame->Schematic().RefreshHierarchy();

    const SCH_SHEET_PATH livePath = m_frame->Schematic().Hierarchy().FindSheetForScreen( screen );

    // Symbols the fold parsed from fragments carry their instance relative to the sending
    // sheet; anchor them like a landing fragment or they serialise with no instance block.
    for( SCH_ITEM* item : serverScreen->Items().OfType( SCH_SYMBOL_T ) )
        SCH_COLLAB::AnchorSymbolInstance( static_cast<SCH_SYMBOL*>( item ), livePath.Path() );

    // A join writes the merged in-memory document as the new base, so once this copy is
    // closed without saving, the file on disk is OLDER than the base: whatever differs
    // between them is the last save, not an edit made offline.  Treating it as one pushed
    // the stale file over everyone's newer work.  A file written after the base is the
    // only kind that can hold offline edits.
    //
    // That is a statement about the file, though.  A sheet edited since it was opened
    // (a copy opened with the server out of reach, worked on, and joining only now) holds
    // edits no file time knows about, and they are measured against the base like any
    // other.
    bool localIsStale = false;

    if( haveBase && !memoryBase && !screen->IsContentModified() )
    {
        wxFileName localFile( screen->GetFileName() );
        wxFileName baseFile( COLLAB_PROJECT::SyncBasePath( m_frame->Prj().GetProjectPath(),
                                                           m_frame->Prj().GetProjectName(),
                                                           relPath ) );

        if( localFile.FileExists() && baseFile.FileExists()
            && baseFile.GetModificationTime() > localFile.GetModificationTime() )
        {
            localIsStale = true;
        }
    }

    for( const KIID& id : ids )
    {
        SCH_ITEM* L = find( localItems, id );
        SCH_ITEM* R = find( serverItems, id );
        SCH_ITEM* B = find( baseItems, id );

        std::string ls = L ? SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), screen, L,
                                                          &livePath )
                           : std::string();
        std::string rs = R ? SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), serverScreen, R,
                                                          &livePath )
                           : std::string();
        std::string bs = B ? SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), baseScreen, B,
                                                          &livePath )
                           : std::string();

        // An item that will not serialize cannot be compared; leave it be.
        if( ( L && ls.empty() ) || ( R && rs.empty() ) )
            continue;

        // Both sides agree already, whoever changed what.
        if( ( !L && !R ) || ( L && R && ls == rs ) )
            continue;

        // An edit of ours the server would not take: its version stands.
        if( aRefusedIds.count( id ) )
        {
            if( R )
                fromOnline.push_back( upsertChange( R, std::move( rs ) ) );
            else
                fromOnline.push_back( removeChange( id ) );

            continue;
        }

        // An item one of our unacknowledged ops touched was changed here, whatever a
        // comparison with the base makes of it.
        const bool own = aOwnIds.count( id.AsStdString() ) > 0;

        if( !haveBase )
        {
            if( own )
            {
                // No base to tell whether the online copy moved as well: ours is the
                // edit known to be newer than the snapshot.
                if( L )
                    toOnline.push_back( upsertChange( L, std::move( ls ) ) );
                else
                    toOnline.push_back( removeChange( id ) );

                kept++;
            }
            else if( L && !R )
            {
                fromOnline.push_back( removeChange( id ) );
            }
            else
            {
                fromOnline.push_back( upsertChange( R, std::move( rs ) ) );
            }

            continue;
        }

        const bool haveB = B && !bs.empty();
        const bool localChanged = own
                                  || ( !localIsStale
                                       && ( ( L != nullptr ) != haveB || ( L && ls != bs ) ) );
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

    // The base is what this copy's file and the server last agreed on.  The file on disk
    // has now been reconciled: what it had that the server lacked was just pushed, and what
    // the server had is in memory.  So the file as it stands on disk is the base.  Writing the
    // merged board instead would be wrong whenever the user then closes without saving: the
    // next merge would compare the old file with a newer base, read every collaborator's
    // change as a local edit that undoes it, and push those "edits" back to everyone.
    //
    // Not while anything of ours is still unacknowledged, though: what the file holds
    // that the server does not have yet would become "unchanged", and if the editor
    // closed before the acknowledgement the next merge would take its absence online
    // for a deletion.  OnAck does it once nothing of this document is waiting.
    if( m_outbox.Count( aDocId ) == 0 )
        refreshBaseAfterMerge( aDocId );
    else
        m_baseRefreshAfterMerge.insert( aDocId );

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


void SCH_COLLAB_SYNC::refreshBaseAfterMerge( const wxString& aDocId )
{
    m_baseRefreshAfterMerge.erase( aDocId );

    bool fromDisk = false;

    if( m_pathByDocId.count( aDocId ) )
    {
        const wxString& rel = m_pathByDocId.at( aDocId );
        wxFileName      onDisk( m_frame->Prj().GetProjectPath() + wxFileName::GetPathSeparator()
                                + wxFileName( rel, wxPATH_UNIX ).GetFullPath() );

        if( onDisk.FileExists() )
        {
            COLLAB_PROJECT::RefreshSyncBaseFromDisk( m_frame->Prj().GetProjectPath(),
                                                     m_frame->Prj().GetProjectName(), rel );
            fromDisk = true;
        }
    }

    if( !fromDisk )
        writeSyncBase( aDocId );
}


void SCH_COLLAB_SYNC::writeSyncBase( const wxString& aDocId )
{
    if( !m_pathByDocId.count( aDocId ) )
        return;

    std::string text = formatDoc( aDocId );

    if( !text.empty() )
    {
        COLLAB_PROJECT::WriteSyncBase( m_frame->Prj().GetProjectPath(),
                                       m_frame->Prj().GetProjectName(),
                                       m_pathByDocId.at( aDocId ), text );
    }
}


std::string SCH_COLLAB_SYNC::formatDoc( const wxString& aDocId )
{
    SCH_SCREEN* screen = screenForDocId( aDocId );

    if( !screen )
        return std::string();

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
        return std::string();

    try
    {
        STRING_FORMATTER   formatter;
        SCH_IO_KICAD_SEXPR plugin;

        // The writer keeps the sheet's loaded format version and raises it only when the design
        // needs it.  There is no user in this path, so route that to the collab log: a base that
        // silently jumped to the current format is the first sign the project stopped being
        // openable by a collaborator on a stable KiCad.
        WX_STRING_REPORTER formatReporter;
        plugin.SetReporter( &formatReporter );

        plugin.FormatSchematicToFormatter( &formatter, sheet, &m_frame->Schematic() );

        if( formatReporter.HasMessage() )
            wxLogTrace( traceCollab, wxS( "sync base: %s" ), formatReporter.GetMessages() );

        return formatter.GetString();
    }
    catch( const IO_ERROR& ioe )
    {
        wxLogTrace( traceCollab, wxS( "sync base serialization failed: %s" ), ioe.What() );
    }

    return std::string();
}


void SCH_COLLAB_SYNC::RefreshSyncBasesFromDisk()
{
    for( const auto& [path, docId] : m_docIdByPath )
    {
        const bool inFlight = m_outbox.Count( docId ) > 0;

        // Only a fully acknowledged save is the server's state.  Otherwise take it once
        // the last acknowledgement is in (OnAck), if nothing was edited again by then.
        if( inFlight )
            m_baseRefreshWanted = true;

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

    // The snapshot is a complete kicad_sch document, which needs the full-file parse mode.
    SCH_SHEET tempSheet;

    // Screen object on heap is owned by the sheet (the paste-path pattern).
    SCH_SCREEN* tempScreen = new SCH_SCREEN( &m_frame->Schematic() );
    tempSheet.SetScreen( tempScreen );

    wxString error;

    if( !SCH_COLLAB::ParseIntoScreen( aFileText, tempSheet, &error ) )
    {
        wxLogTrace( traceCollab, wxS( "rollback: snapshot parse failed: %s" ), error );
        return;
    }

    if( !m_frame->Schematic().HasHierarchy() )
        m_frame->Schematic().RefreshHierarchy();

    const SCH_SHEET_PATH livePath = m_frame->Schematic().Hierarchy().FindSheetForScreen( screen );

    for( SCH_ITEM* item : tempScreen->Items().OfType( SCH_SYMBOL_T ) )
        SCH_COLLAB::AnchorSymbolInstance( static_cast<SCH_SYMBOL*>( item ), livePath.Path() );

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
            std::string sexpr = SCH_COLLAB::FormatItemSexpr( m_frame->Schematic(), tempScreen,
                                                             item, &livePath );

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


void SCH_COLLAB_SYNC::OnSnapshotRequest( const wxString& aDocId )
{
    uploadSheetPreviews();

    // Serve the sheet that was actually asked for.  Serving whatever happens to be on screen
    // instead means a sheet nobody is displaying never gets a snapshot at all — the actor
    // stamps its cooldown on every request and its join catch-up, /content, gallery preview
    // and clones stay at the pre-session version for as long as the session runs.
    wxString    docId = aDocId;
    SCH_SCREEN* screen = docId.IsEmpty() ? m_frame->GetScreen() : screenForDocId( docId );

    if( docId.IsEmpty() )
        docId = docIdForScreen( screen );

    if( docId.IsEmpty() || !screen )
        return;

    if( m_outbox.Count( docId ) > 0 )
    {
        wxLogTrace( traceCollab, wxS( "snapshot request skipped: ops in flight for %s" ), docId );
        return;
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

    m_outbox.Clear( aDocId );

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

        const bool applied = applyOp( op );

        lastApplied = op.seq;

        // Tell the session how far we have actually applied, so a reconnect
        // asks for the tail from here rather than from what merely arrived.
        // An op we could not apply (no local screen for its doc) must NOT move that mark:
        // reporting it would tell the server we are caught up and the edits would never be
        // sent again — permanently lost, with nothing said to anyone.
        if( applied )
            session.SetAppliedSeq( op.docId, lastApplied );
    }
}


bool SCH_COLLAB_SYNC::applyOp( const PENDING_OP& aOp )
{
    SCH_SCREEN* screen = screenForDocId( aOp.docId );

    if( !screen )
    {
        wxLogTrace( traceCollab, wxS( "no local screen for doc %s; op %lld skipped" ),
                    aOp.docId, aOp.seq );

        if( wxGetEnv( wxS( "KICAD_LOG_TO_STDERR" ), nullptr ) )
        {
            fprintf( stderr, "COLLAB no local screen for doc %s; op %lld not applied\n",
                     aOp.docId.ToStdString( wxConvUTF8 ).c_str(), aOp.seq );
        }

        return false;
    }

    if( !aOp.changes.is_array() || aOp.changes.empty() )
        return true;

    APPLYING_REMOTE_SCOPE applying( m_applyingRemote );

    // Acks and broadcasts share one in-order stream, so any own op acked with a seq above
    // this op's -- and any still unacked -- is provably NEWER than this remote op.  Those
    // are re-asserted over what it touches (see ApplyRemoteOp), oldest first.
    std::vector<const nlohmann::json*> newerOwn;

    for( const auto& [ownSeq, changes] : m_ownRecent[ aOp.docId ] )
    {
        if( ownSeq > aOp.seq )
            newerOwn.push_back( &changes );
    }

    // The outbox holds them in the order they were made.
    for( const COLLAB_OUTBOX::OP& op : m_outbox.Ops() )
    {
        if( op.docId == aOp.docId )
            newerOwn.push_back( &op.changes );
    }

    // A sheet that is about to be removed may be the one on display, or above it: step
    // out to its parent first.  The removal frees the sheet, and a frame left showing a
    // screen that is no longer in the hierarchy crashes on its next repaint.
    for( const nlohmann::json& change : aOp.changes )
    {
        if( !change.is_object() || change.value( "kind", "" ) != "REMOVED" )
            continue;

        KIID id( wxString::FromUTF8( change.value( "id", "" ) ) );

        const SCH_SHEET_PATH& current = m_frame->GetCurrentSheet();

        for( size_t ii = 0; ii < current.size(); ++ii )
        {
            if( current.at( ii )->m_Uuid != id )
                continue;

            SCH_SHEET_PATH parent;

            for( size_t jj = 0; jj < ii; ++jj )
                parent.push_back( current.at( jj ) );

            if( parent.size() > 0 )
            {
                m_frame->GetToolManager()->RunAction<SCH_SHEET_PATH*>( SCH_ACTIONS::changeSheet,
                                                                       &parent );
            }

            // The frame may have switched screens under us.
            screen = screenForDocId( aOp.docId );
            break;
        }
    }

    if( !screen )
        return false;

    // The presence overlay draws ghosts of local items a collaborator is dragging, by
    // pointer, and this edit may free those very items.  See PCB_COLLAB_SYNC::applyOp.
    SCH_COLLAB_TOOL* collabTool = m_frame->GetToolManager()
                                          ? m_frame->GetToolManager()->GetTool<SCH_COLLAB_TOOL>()
                                          : nullptr;

    if( collabTool )
        collabTool->ForgetGhostItems();

    SCH_COLLAB::ApplyRemoteOp( m_frame->Schematic(), screen, aOp.changes, newerOwn,
                               m_frame->GetToolManager(),
                               [this]( SCH_ITEM* aItem )
                               {
                                   // Scrub the undo/redo stacks before the item is freed,
                                   // so a later local undo cannot dereference it.
                                   m_frame->PurgeItemFromUndoRedo( aItem->m_Uuid );
                               } );

    if( collabTool )
        collabTool->RefreshOverlay();

    // The frame only re-tests dangling ends after its own edits, so a remote move or
    // upsert left "unconnected" circles on pins whose wires plainly reach them.
    if( screen && m_frame->GetCanvas() )
    {
        std::function<void( SCH_ITEM* )> repaint =
                [this]( SCH_ITEM* aItem )
                {
                    m_frame->GetCanvas()->GetView()->Update( aItem, KIGFX::REPAINT );
                };

        SCH_SHEET_PATH path = m_frame->Schematic().Hierarchy().FindSheetForScreen( screen );
        screen->TestDanglingEnds( path.size() > 0 ? &path : nullptr, &repaint );
    }

    saveMissingLibraries( aOp.changes );
    ensureSheetDocs( aOp.docId, aOp.changes, false );

    return true;
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

        wxString file = relPathForSheet( screen, sheet );
        file.Replace( wxS( "\\" ), wxS( "/" ) );

        // A sheet of a file we already sync that arrived with a brand-new, empty screen:
        // the file was closed here (its last sheet was deleted, and this is the delete
        // being undone or the sheet being moved to another parent).  The document is
        // still joined, so ask for its state again and rebuild the screen from it.
        if( !aIsAuthor && kind == "ADDED" && !file.IsEmpty() && m_docIdByPath.count( file )
            && sheet->GetScreen() && sheet->GetScreen()->Items().empty() )
        {
            const wxString docId = m_docIdByPath[ file ];

            m_takeServer.insert( docId );
            m_resyncPending[ docId ] = true;
            COLLAB_SESSION::Get().RequestResync( docId );
            continue;
        }

        if( file.IsEmpty() || m_docIdByPath.count( file )
            || !m_ensuredSheetFiles.insert( file ).second )
        {
            continue;
        }

        createSheetDoc( file, sheet, aIsAuthor );
    }
}


void SCH_COLLAB_SYNC::retrySheetDocs()
{
    if( m_failedSheetFiles.empty() )
        return;

    std::set<wxString> failed;
    failed.swap( m_failedSheetFiles );

    for( const SCH_SHEET_PATH& path : m_frame->Schematic().Hierarchy() )
    {
        if( path.size() < 2 )
            continue;   // the root sheet has no file of its own to add

        SCH_SHEET* sheet = path.Last();
        wxString   file = relPathForSheet( path.at( path.size() - 2 )->GetScreen(), sheet );
        file.Replace( wxS( "\\" ), wxS( "/" ) );

        // Once per file, with the sheet as it is now: what was drawn in it while the
        // server was out of reach goes up as the document's first snapshot.
        if( !failed.erase( file ) || m_docIdByPath.count( file ) )
            continue;

        m_ensuredSheetFiles.insert( file );
        createSheetDoc( file, sheet, true );
    }
}


void SCH_COLLAB_SYNC::createSheetDoc( const wxString& aFile, SCH_SHEET* aSheet, bool aIsAuthor )
{
    wxString projectId = COLLAB_SESSION::Get().ProjectId();
    wxString file = aFile;

    {
        SCH_SHEET* sheet = aSheet;

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
                    {
                        // Out of reach, most likely.  An author tries again when the
                        // connection is back (retrySheetDocs); until then the sheet's
                        // content has no document to go to.
                        wxTheApp->CallAfter(
                                [this, alive, fileStd, aIsAuthor]()
                                {
                                    if( !*alive )
                                        return;

                                    wxString failedFile = wxString::FromUTF8( fileStd );

                                    m_ensuredSheetFiles.erase( failedFile );

                                    if( aIsAuthor )
                                        m_failedSheetFiles.insert( failedFile );
                                } );

                        return;
                    }

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
            auto copy = std::make_unique<LIB_SYMBOL>( *symbol->GetLibSymbolRef() );
            copy->SetName( symbol->GetLibId().GetLibItemName() );
            io.SaveSymbol( libFile.GetFullPath(), std::move( copy ) );
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
