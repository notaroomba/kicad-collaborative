/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 3
 * of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, you may find one here:
 * http://www.gnu.org/licenses/gpl-3.0.html
 */

/**
 * Convergence tests for the collaborative-editing wire format: changes captured from
 * one schematic (property diffs / single-item s-expressions) applied to a second,
 * independently loaded schematic must reproduce the first schematic's state.
 *
 * These drive the frame-free SCH_COLLAB::ApplyItemChange() / FormatItemSexpr() layer
 * (aCommit == nullptr); the SCH_COMMIT-staged path shares the same mutation code but
 * needs a live frame and is exercised manually.
 */

#include <algorithm>
#include <qa_utils/wx_utils/unit_test_utils.h>
#include <schematic_utils/schematic_file_util.h>

#include <collab/sch_collab_sync.h>
#include <collab/collab_session.h>

#include <diff_merge/kicad_diff_types.h>
#include <diff_merge/property_diff.h>
#include <diff_merge/sch_diff_utils.h>

#include <schematic.h>
#include <sch_io/kicad_sexpr/sch_io_kicad_sexpr.h>
#include <sch_screen.h>
#include <sch_sheet.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/utils.h>
#include <sch_sheet_path.h>
#include <reporter.h>
#include <sch_symbol.h>
#include <settings/settings_manager.h>
#include <tool/tool_manager.h>

#include <nlohmann/json.hpp>


using namespace KICAD_DIFF;


struct COLLAB_SYNC_FIXTURE
{
    COLLAB_SYNC_FIXTURE()
    {
        // Two independent loads of the same fixture: identical KIIDs, separate objects.
        KI_TEST::LoadSchematic( m_settingsA, "issue18606/issue18606", m_authoring );
        KI_TEST::LoadSchematic( m_settingsB, "issue18606/issue18606", m_receiving );
        BOOST_REQUIRE( m_authoring );
        BOOST_REQUIRE( m_receiving );
    }

    ///< First symbol on any sheet, with its sheet path and screen.
    static SCH_SYMBOL* FindAnySymbol( SCHEMATIC& aSchematic, SCH_SHEET_PATH* aPathOut )
    {
        for( const SCH_SHEET_PATH& path : aSchematic.BuildSheetListSortedByPageNumbers() )
        {
            SCH_SCREEN* screen = path.LastScreen();

            if( !screen )
                continue;

            for( SCH_ITEM* item : screen->Items().OfType( SCH_SYMBOL_T ) )
            {
                if( aPathOut )
                    *aPathOut = path;

                return static_cast<SCH_SYMBOL*>( item );
            }
        }

        return nullptr;
    }

    ///< The receiving-side item with the same KIID, and its screen.
    static SCH_ITEM* FindTwin( SCHEMATIC& aSchematic, const KIID& aId, SCH_SCREEN** aScreenOut )
    {
        for( const SCH_SHEET_PATH& path : aSchematic.BuildSheetListSortedByPageNumbers() )
        {
            SCH_SCREEN* screen = path.LastScreen();

            if( !screen )
                continue;

            for( SCH_ITEM* item : screen->Items() )
            {
                if( item->m_Uuid == aId )
                {
                    if( aScreenOut )
                        *aScreenOut = screen;

                    return item;
                }
            }
        }

        return nullptr;
    }

    ///< Every entry of the screen's RTree must still be a live object: the plot that follows
    ///< a remote op walks them all, and a freed one there crashed the editor on its first
    ///< virtual call.  (Run under MallocScribble=1 to make a freed entry fail for certain.)
    static void CheckEveryItemIsLive( SCH_SCREEN* aScreen )
    {
        for( SCH_ITEM* item : aScreen->Items() )
            BOOST_CHECK( !item->GetClass().IsEmpty() );
    }

    ///< Minimal wire-format change object (the fields the apply path consumes).
    static nlohmann::json MakeChange( const SCH_ITEM* aItem, const char* aKind )
    {
        nlohmann::json change;
        change[ "id" ] = aItem->m_Uuid.AsStdString();
        change[ "typeName" ] = aItem->GetClass().ToStdString();
        change[ "kind" ] = aKind;
        change[ "properties" ] = nlohmann::json::array();
        return change;
    }

    SETTINGS_MANAGER           m_settingsA;
    SETTINGS_MANAGER           m_settingsB;
    std::unique_ptr<SCHEMATIC> m_authoring;
    std::unique_ptr<SCHEMATIC> m_receiving;
};


BOOST_FIXTURE_TEST_SUITE( CollabSync, COLLAB_SYNC_FIXTURE )


BOOST_AUTO_TEST_CASE( SheetAddRoundTrips )
{
    // The author adds a hierarchical sheet; the receiver must materialize it
    // with a fresh (empty) screen — the doc join fills the content in later.
    SCH_SHEET_PATH authorPath;
    SCH_SYMBOL*    anySymbol = FindAnySymbol( *m_authoring, &authorPath );
    BOOST_REQUIRE( anySymbol != nullptr );
    SCH_SCREEN* authorScreen = authorPath.LastScreen();

    SCH_SHEET* sheet = new SCH_SHEET( authorScreen, VECTOR2I( schIUScale.MilsToIU( 8000 ),
                                                              schIUScale.MilsToIU( 1000 ) ) );
    sheet->SetName( wxS( "SubTest" ) );
    sheet->SetFileName( wxS( "subtest.kicad_sch" ) );
    sheet->SetScreen( new SCH_SCREEN( m_authoring.get() ) );
    authorScreen->Append( sheet );
    m_authoring->RefreshHierarchy();

    std::string sexpr = SCH_COLLAB::FormatItemSexpr( *m_authoring, authorScreen, sheet );
    BOOST_REQUIRE( !sexpr.empty() );

    // Fixture generator for wire-level tests: dump the exact on-the-wire
    // fragment so external harnesses replay genuine formatter output.
    wxString dumpPath;

    if( wxGetEnv( wxS( "KICAD_QA_DUMP_SHEET_SEXPR" ), &dumpPath ) && !dumpPath.IsEmpty() )
    {
        FILE* out = fopen( dumpPath.ToStdString( wxConvUTF8 ).c_str(), "w" );

        if( out )
        {
            fwrite( sexpr.data(), 1, sexpr.size(), out );
            fclose( out );
        }
    }

    nlohmann::json change = MakeChange( sheet, "ADDED" );
    change[ "sexpr" ] = sexpr;

    SCH_SCREEN* twinScreen = nullptr;
    FindTwin( *m_receiving, anySymbol->m_Uuid, &twinScreen );
    BOOST_REQUIRE( twinScreen != nullptr );

    BOOST_REQUIRE(
            SCH_COLLAB::ApplyItemChange( *m_receiving, twinScreen, change, nullptr ) );

    SCH_SCREEN* foundScreen = nullptr;
    SCH_ITEM*   applied = FindTwin( *m_receiving, sheet->m_Uuid, &foundScreen );

    BOOST_REQUIRE( applied != nullptr );
    BOOST_REQUIRE( applied->Type() == SCH_SHEET_T );

    SCH_SHEET* appliedSheet = static_cast<SCH_SHEET*>( applied );
    BOOST_CHECK( appliedSheet->GetFileName() == wxS( "subtest.kicad_sch" ) );
    BOOST_REQUIRE( appliedSheet->GetScreen() != nullptr );

    // Upsert-replace must keep the live screen (the fragment has none).
    nlohmann::json replace = MakeChange( sheet, "MODIFIED" );
    replace[ "sexpr" ] = SCH_COLLAB::FormatItemSexpr( *m_authoring, authorScreen, sheet );

    SCH_SCREEN* keep = appliedSheet->GetScreen();
    BOOST_REQUIRE(
            SCH_COLLAB::ApplyItemChange( *m_receiving, twinScreen, replace, nullptr ) );
    BOOST_CHECK( appliedSheet->GetScreen() == keep );

    // Removal detaches the sheet.
    nlohmann::json removal = MakeChange( sheet, "REMOVED" );
    BOOST_REQUIRE(
            SCH_COLLAB::ApplyItemChange( *m_receiving, twinScreen, removal, nullptr ) );
    BOOST_CHECK( FindTwin( *m_receiving, sheet->m_Uuid, nullptr ) == nullptr );
}


BOOST_AUTO_TEST_CASE( ModifiedPropertiesConverge )
{
    SCH_SHEET_PATH pathA;
    SCH_SYMBOL*    subject = FindAnySymbol( *m_authoring, &pathA );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    // Author edit: move the symbol.
    VECTOR2I newPos = subject->GetPosition() + VECTOR2I( 5000, 2500 );
    subject->SetPosition( newPos );

    // Capture: the twin still holds the before state, the subject the after state.
    std::vector<PROPERTY_DELTA> deltas;

    {
        SHEET_SCOPE scopeA( m_authoring.get(), &pathA );
        deltas = DiffItemProperties( twin, subject );
    }

    BOOST_REQUIRE( !deltas.empty() );

    nlohmann::json change = MakeChange( subject, "MODIFIED" );

    for( const PROPERTY_DELTA& delta : deltas )
        change[ "properties" ].push_back( delta.ToJson() );

    // Round-trip through text like the real wire does.
    change = nlohmann::json::parse( change.dump() );

    BOOST_REQUIRE( SCH_COLLAB::ApplyItemChange( *m_receiving, screenB, change, nullptr ) );

    BOOST_CHECK_EQUAL( twin->GetPosition().x, newPos.x );
    BOOST_CHECK_EQUAL( twin->GetPosition().y, newPos.y );
}


BOOST_AUTO_TEST_CASE( RemovedChangeConvergesAndIsIdempotent )
{
    SCH_SYMBOL* subject = FindAnySymbol( *m_authoring, nullptr );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    KIID id = subject->m_Uuid;

    nlohmann::json change = MakeChange( subject, "REMOVED" );

    BOOST_REQUIRE( SCH_COLLAB::ApplyItemChange( *m_receiving, screenB, change, nullptr ) );
    BOOST_CHECK( FindTwin( *m_receiving, id, nullptr ) == nullptr );

    // A second delivery (or a delete racing a modify) must be a silent no-op.
    BOOST_CHECK( SCH_COLLAB::ApplyItemChange( *m_receiving, screenB, change, nullptr ) );
}


BOOST_AUTO_TEST_CASE( AddedSexprRoundTripConverges )
{
    SCH_SHEET_PATH pathA;
    SCH_SYMBOL*    subject = FindAnySymbol( *m_authoring, &pathA );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenA = pathA.LastScreen();
    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    KIID id = subject->m_Uuid;

    // Simulate the receiver never having had the item.
    screenB->Remove( twin );
    delete twin;
    BOOST_REQUIRE( FindTwin( *m_receiving, id, nullptr ) == nullptr );

    std::string sexpr = SCH_COLLAB::FormatItemSexpr( *m_authoring, screenA, subject );
    BOOST_REQUIRE( !sexpr.empty() );

    nlohmann::json change = MakeChange( subject, "ADDED" );
    change[ "sexpr" ] = sexpr;

    BOOST_REQUIRE( SCH_COLLAB::ApplyItemChange( *m_receiving, screenB, change, nullptr ) );

    SCH_ITEM* rebuilt = FindTwin( *m_receiving, id, nullptr );
    BOOST_REQUIRE( rebuilt );

    // The KIID must survive the round trip (never rewritten on apply) and the geometry
    // must match the author's item.
    BOOST_CHECK( rebuilt->m_Uuid == id );
    BOOST_CHECK_EQUAL( rebuilt->GetPosition().x, subject->GetPosition().x );
    BOOST_CHECK_EQUAL( rebuilt->GetPosition().y, subject->GetPosition().y );
    BOOST_CHECK_EQUAL( rebuilt->GetClass().ToStdString(), subject->GetClass().ToStdString() );
}


BOOST_AUTO_TEST_CASE( AddedWithExistingUuidUpserts )
{
    SCH_SHEET_PATH pathA;
    SCH_SYMBOL*    subject = FindAnySymbol( *m_authoring, &pathA );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenA = pathA.LastScreen();
    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    VECTOR2I newPos = subject->GetPosition() + VECTOR2I( -3000, 7000 );
    subject->SetPosition( newPos );

    nlohmann::json change = MakeChange( subject, "ADDED" );
    change[ "sexpr" ] = SCH_COLLAB::FormatItemSexpr( *m_authoring, screenA, subject );

    // ADDED with an existing UUID replaces the item in place (highest seq wins).
    BOOST_REQUIRE( SCH_COLLAB::ApplyItemChange( *m_receiving, screenB, change, nullptr ) );

    SCH_ITEM* replaced = FindTwin( *m_receiving, subject->m_Uuid, nullptr );
    BOOST_REQUIRE( replaced );
    BOOST_CHECK( replaced == twin );    // same live object, swapped data
    BOOST_CHECK_EQUAL( replaced->GetPosition().x, newPos.x );
    BOOST_CHECK_EQUAL( replaced->GetPosition().y, newPos.y );
}


// KiCad Collaborative must not restamp the file format version on save: a
// project shared with a stock KiCad keeps the version it was opened with.  The version is
// only kept when the bytes actually fit in it; when they do not it is raised and the reason
// reported, so an older KiCad never gets a file that lies about its format.
BOOST_AUTO_TEST_CASE( SaveKeepsFileFormatVersion )
{
    SCH_SHEET*  root = &m_authoring->Root();
    SCH_SCREEN* screen = root->GetScreen();
    BOOST_REQUIRE( screen );

    WX_STRING_REPORTER reporter;

    auto savedVersion = [&]( int aAtLoad ) -> std::string
    {
        screen->SetFileFormatVersionAtLoad( aAtLoad );
        reporter.Clear();

        wxString         tmp = wxFileName::CreateTempFileName( wxS( "collab_ver" ) );
        SCH_IO_KICAD_SEXPR io;

        io.SetReporter( &reporter );
        io.SaveSchematicFile( tmp, root, m_authoring.get() );

        wxFFile   file( tmp, wxS( "r" ) );
        wxString  content;
        file.ReadAll( &content );
        wxRemoveFile( tmp );

        int start = content.Find( wxS( "(version " ) );
        BOOST_REQUIRE( start != wxNOT_FOUND );
        return content.Mid( start + 9, content.Mid( start + 9 ).Find( ')' ) ).ToStdString();
    };

    // A file opened at the version stock KiCad 10.0 writes keeps that version, silently.
    BOOST_CHECK_EQUAL( savedVersion( 20260306 ), "20260306" );
    BOOST_CHECK( !reporter.HasMessage() );

    // A file too old to express what the writer emits is raised instead of being stamped with a
    // version it does not match -- and the user is told.  Every sheet carries (embedded_fonts),
    // which landed at 20240620, so a file claiming to predate that cannot hold what we write.
    // (Note this fixture's root sheet has no symbols of its own -- they live on the sub-sheet --
    // so symbol-only tokens such as body_style are not what forces the upgrade here.)
    const std::string raised = savedVersion( 20230121 );
    BOOST_CHECK_MESSAGE( std::stoi( raised ) > 20230121,
                         "expected the stamp to be raised above 20230121, got " + raised );
    BOOST_CHECK( reporter.HasMessage() );

    // A legacy-format import (small integer version) gets the current stamp.
    BOOST_CHECK( savedVersion( 2 ) != "2" );

    // Stock stamping on request.
    wxSetEnv( wxS( "KICAD_COLLAB_STAMP_VERSIONS" ), wxS( "1" ) );
    BOOST_CHECK( savedVersion( 20260306 ) != "20260306" );
    wxUnsetEnv( wxS( "KICAD_COLLAB_STAMP_VERSIONS" ) );
}


// A sheet added after the project was opened has no version of its own.  It must inherit the
// root sheet's, or the project ends up with one 10.99 file inside an otherwise older project
// that stock KiCad opens at the root and then refuses at the sub-sheet.
BOOST_AUTO_TEST_CASE( NewSheetInheritsRootFileFormatVersion )
{
    SCH_SHEET*  root = &m_authoring->Root();

    // SCHEMATIC::RootScreen() resolves to the first top-level sheet's screen, not the virtual
    // root's container screen; that is the one a new sheet inherits from.
    SCH_SCREEN* rootScreen = m_authoring->RootScreen();
    BOOST_REQUIRE( rootScreen );

    rootScreen->SetFileFormatVersionAtLoad( 20260306 );

    SCH_SHEET   added( root, VECTOR2I( 0, 0 ) );
    SCH_SCREEN* addedScreen = new SCH_SCREEN( m_authoring.get() );

    added.SetScreen( addedScreen );
    BOOST_REQUIRE_EQUAL( addedScreen->GetFileFormatVersionAtLoad(), 0 );

    wxString tmp = wxFileName::CreateTempFileName( wxS( "collab_ver_sheet" ) );
    SCH_IO_KICAD_SEXPR().SaveSchematicFile( tmp, &added, m_authoring.get() );

    wxFFile  file( tmp, wxS( "r" ) );
    wxString content;
    file.ReadAll( &content );
    wxRemoveFile( tmp );

    BOOST_CHECK( content.Contains( wxS( "(version 20260306)" ) ) );
}


// The reported bug: opening a schematic in a linked project auto-rejoins, and File > Copy
// Share Link then says "No collaboration session; start or join one first" while the same
// File menu greys out Start/Join and offers Leave Session.
//
// The two halves of the menu read different state.  SCH_COLLAB_TOOL::sessionActive() is
// "the doc map is populated" (sch_collab_tool.h:69); CopyShareLink instead requires
// COLLAB_SESSION::Get().ProjectId() to be non-empty (sch_collab_tool.cpp:1177).  When
// another editor of the same process had already connected, tryAutoJoin took the reuse
// path and handed beginSession a project synthesized out of the published doc list --
// {"docs": [...]} and nothing else -- and beginSession folded that in with an
// unconditional SetProjectId( aProject.value( "projectId", "" ) ), wiping the id the first
// editor had established.  Docs still there, id gone: live by one measure, absent by the
// other.
//
// beginSession itself needs a live SCH_EDIT_FRAME (it builds an SCH_COLLAB_SYNC and shows
// infobars), so it is not reachable headless; the rule it applies now lives in
// SCH_COLLAB::ResolveProjectId / ResolveOwnerId, and that is what is driven here, against
// the real process-wide COLLAB_SESSION that CopyShareLink reads.
BOOST_AUTO_TEST_CASE( AutoJoinBesideConnectedEditorKeepsProjectId )
{
    const wxString linkedId = wxS( "c0ffee42-1111-2222-3333-444455556666" );  // from link.json

    nlohmann::json docs = nlohmann::json::array();
    docs.push_back( { { "docId", "doc-sch-1" },
                      { "docType", "kicad_sch" },
                      { "path", "issue18606.kicad_sch" } } );

    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    // First editor: a real project payload from the server starts the session.
    nlohmann::json served = { { "projectId", linkedId.ToStdString() },
                              { "ownerId", 41 },
                              { "docs", docs } };

    long long ownerId = SCH_COLLAB::ResolveOwnerId( served, 0 );
    session.SetProjectDocs( served.value( "docs", nlohmann::json::array() ) );
    session.SetProjectId( SCH_COLLAB::ResolveProjectId( served, session.ProjectId() ) );

    BOOST_REQUIRE_EQUAL( session.ProjectId(), linkedId );
    BOOST_REQUIRE_EQUAL( ownerId, 41 );

    // Second editor, auto-joining beside it: exactly the payload tryAutoJoin's reuse path
    // built before the fix -- the doc list alone, no identity at all.
    nlohmann::json synthesized = { { "docs", session.ProjectDocs() } };

    ownerId = SCH_COLLAB::ResolveOwnerId( synthesized, ownerId );
    session.SetProjectDocs( synthesized.value( "docs", nlohmann::json::array() ) );
    session.SetProjectId( SCH_COLLAB::ResolveProjectId( synthesized, session.ProjectId() ) );

    // What the File menu reads: the doc list is populated, so the session is "active".
    BOOST_CHECK( session.ProjectDocs().is_array() );
    BOOST_CHECK( !session.ProjectDocs().empty() );

    // What File > Copy Share Link reads.  These two must not disagree.
    BOOST_CHECK_EQUAL( session.ProjectId(), linkedId );
    BOOST_CHECK( !session.ProjectId().IsEmpty() );

    // And the host/guest wording keeps its answer too.
    BOOST_CHECK_EQUAL( ownerId, 41 );

    // The other half of the fix: tryAutoJoin now puts link.json's id in the synthesized
    // payload, so the reuse path describes the session fully even from a cold id.
    nlohmann::json carried = { { "docs", session.ProjectDocs() },
                               { "projectId", linkedId.ToStdString() } };
    BOOST_CHECK_EQUAL( SCH_COLLAB::ResolveProjectId( carried, wxEmptyString ), linkedId );

    // A payload that really does carry an identity still wins, empty string included:
    // "carries the key" is the rule, not "carries a non-empty value".
    nlohmann::json other = { { "projectId", "99999999-0000-0000-0000-000000000000" } };
    BOOST_CHECK_EQUAL( SCH_COLLAB::ResolveProjectId( other, linkedId ),
                       wxS( "99999999-0000-0000-0000-000000000000" ) );
    BOOST_CHECK( SCH_COLLAB::ResolveProjectId( { { "projectId", "" } }, linkedId ).IsEmpty() );
    BOOST_CHECK_EQUAL( SCH_COLLAB::ResolveOwnerId( { { "ownerId", 7 } }, 41 ), 7 );

    // The session singleton is process-wide; leave it as we found it.
    session.SetProjectId( wxEmptyString );
    session.SetProjectDocs( nlohmann::json::array() );
}


// The two "one editor kills the other" bugs, from the schematic side.
//
// COLLAB_SESSION is process-wide and owns a single WebSocket: eeschema joins its
// kicad_sch documents over it and pcbnew joins the board's.  Both editors' endSession()
// used to call COLLAB_SESSION::Disconnect() unconditionally, so File > Leave Session in
// one -- or just closing that window, which reaches endSession() through
// Reset( SHUTDOWN ) -- destroyed the socket under the other, which was never told: its
// File menu went on greying out Start/Join and offering Leave Session while nothing
// synced and no reconnect was possible.
//
// The connection now goes when the last document does.  The tools' endSession()s are
// frame-bound, so what is driven here is the session rule they both call.
BOOST_AUTO_TEST_CASE( LeavingOneEditorKeepsTheOtherOnesConnection )
{
    struct STUB_ADAPTER : public COLLAB_DOC_ADAPTER {};

    STUB_ADAPTER    schematicEditor;
    STUB_ADAPTER    boardEditor;
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    const wxString projectId = wxS( "c0ffee42-1111-2222-3333-444455556666" );

    nlohmann::json docs = nlohmann::json::array();
    docs.push_back( { { "docId", "doc-sch-1" }, { "docType", "kicad_sch" },
                      { "path", "board.kicad_sch" } } );
    docs.push_back( { { "docId", "doc-sch-2" }, { "docType", "kicad_sch" },
                      { "path", "power.kicad_sch" } } );
    docs.push_back( { { "docId", "doc-pcb" }, { "docType", "kicad_pcb" },
                      { "path", "board.kicad_pcb" } } );

    session.SetProjectId( projectId );
    session.SetProjectDocs( docs );

    session.JoinDoc( wxS( "doc-sch-1" ), std::nullopt, &schematicEditor );
    session.JoinDoc( wxS( "doc-sch-2" ), std::nullopt, &schematicEditor );
    session.JoinDoc( wxS( "doc-pcb" ), std::nullopt, &boardEditor );

    // eeschema leaves: its own docs go, the board editor's stays, so the connection and
    // the project's identity must both survive.
    session.LeaveDoc( wxS( "doc-sch-1" ) );
    session.LeaveDoc( wxS( "doc-sch-2" ) );

    BOOST_CHECK( !session.ReleaseIfIdle() );
    BOOST_CHECK_EQUAL( session.ProjectId(), projectId );
    BOOST_CHECK( !session.ProjectDocs().empty() );

    // Now the board editor leaves too.  Nobody is left, so the session really ends --
    // and takes its identity with it, which is what stops File > Copy Share Link minting
    // an editor invite for a project this process has walked away from.
    session.LeaveDoc( wxS( "doc-pcb" ) );

    BOOST_CHECK( session.ReleaseIfIdle() );
    BOOST_CHECK( session.ProjectId().IsEmpty() );
    BOOST_CHECK( session.ProjectDocs().empty() );
    BOOST_CHECK( session.GetState() == COLLAB_SESSION::STATE::DISCONNECTED );

    // Releasing again is harmless (Leave Session on an already-dead session).
    BOOST_CHECK( session.ReleaseIfIdle() );
}


// The same rule reached the other way: closing an editor window destroys its tool, whose
// destructor calls ForgetAdapter() rather than LeaveDoc() per document.  That path must
// release the connection too -- and must not release one the surviving editor still needs.
BOOST_AUTO_TEST_CASE( ClosingOneEditorReleasesOnlyItsOwnDocs )
{
    struct STUB_ADAPTER : public COLLAB_DOC_ADAPTER {};

    STUB_ADAPTER    schematicEditor;
    STUB_ADAPTER    boardEditor;
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    session.SetProjectId( wxS( "c0ffee42-1111-2222-3333-444455556666" ) );

    session.JoinDoc( wxS( "doc-sch-1" ), std::nullopt, &schematicEditor );
    session.JoinDoc( wxS( "doc-pcb" ), std::nullopt, &boardEditor );

    session.ForgetAdapter( &schematicEditor );

    BOOST_CHECK( !session.ReleaseIfIdle() );
    BOOST_CHECK( !session.ProjectId().IsEmpty() );

    session.ForgetAdapter( &boardEditor );

    BOOST_CHECK( session.ReleaseIfIdle() );
    BOOST_CHECK( session.ProjectId().IsEmpty() );

    session.SetProjectDocs( nlohmann::json::array() );
}



// The web sends item fragments in the copyable-only (clipboard) grammar, and snapshots arrive
// as whole kicad_sch documents.  Those need different parser modes, and feeding a document to
// the copyable-only loader — which is what the merge and rollback paths used to do — throws on
// the very first token and silently discards the server's state.
BOOST_AUTO_TEST_CASE( DocumentAndFragmentBothParse )
{
    const std::string wire =
            "(wire (pts (xy 25.4 25.4) (xy 50.8 25.4)) (stroke (width 0) (type default))"
            " (uuid \"11111111-2222-3333-4444-555555555555\"))";

    auto loadInto = []( SCHEMATIC& aSchematic, const std::string& aText, wxString* aError )
    {
        SCH_SHEET   sheet;
        SCH_SCREEN* screen = new SCH_SCREEN( &aSchematic );
        sheet.SetScreen( screen );

        if( !SCH_COLLAB::ParseIntoScreen( aText, sheet, aError ) )
            return size_t( 0 );

        size_t n = 0;

        for( SCH_ITEM* item : screen->Items() )
        {
            (void) item;
            n++;
        }

        return n;
    };

    wxString error;

    // A bare item root: the clipboard grammar.
    BOOST_CHECK_EQUAL( loadInto( *m_receiving, wire, &error ), 1u );

    // A complete document: this is the snapshot shape, and the one that used to be rejected.
    const std::string document =
            "(kicad_sch (version 20250114) (generator \"eeschema\") (generator_version \"9.0\")"
            " (uuid \"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\") (paper \"A4\") (lib_symbols) "
            + wire + " (sheet_instances (path \"/\" (page \"1\"))))";

    error.clear();
    BOOST_CHECK_EQUAL( loadInto( *m_receiving, document, &error ), 1u );
    BOOST_CHECK( error.IsEmpty() );

    // And a fragment wrapped in a document, which is what an older web client sends.
    error.clear();
    const std::string wrapped =
            "(kicad_sch (version 20250114) (generator \"kicad-collab-web\") " + wire + ")";
    BOOST_CHECK_EQUAL( loadInto( *m_receiving, wrapped, &error ), 1u );
    BOOST_CHECK( error.IsEmpty() );
}


// Everything the desktop's own formatter writes must keep going through the fragment path.
BOOST_AUTO_TEST_CASE( FormattedFragmentIsBareItemRoots )
{
    SCH_SHEET_PATH pathA;
    SCH_SYMBOL*    subject = FindAnySymbol( *m_authoring, &pathA );
    BOOST_REQUIRE( subject );

    std::string sexpr = SCH_COLLAB::FormatItemSexpr( *m_authoring, pathA.LastScreen(), subject );

    BOOST_REQUIRE( !sexpr.empty() );
    BOOST_CHECK( sexpr.rfind( "(kicad_sch", 0 ) != 0 );

    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    nlohmann::json change = MakeChange( subject, "MODIFIED" );
    change[ "sexpr" ] = sexpr;

    BOOST_CHECK( SCH_COLLAB::ApplyItemChange( *m_receiving, screenB, change, nullptr ) );
}


// An oversized presence state is not relayed at all (ws.rs answers bad_message and the client
// drops that), so the sender's cursor freezes and is then evicted.  Clamp before sending.
BOOST_AUTO_TEST_CASE( PresenceIsClampedToTheServerCap )
{
    nlohmann::json state;
    state[ "cursor" ] = { 1000, 2000 };
    state[ "viewport" ] = { 0, 0, 100000, 100000 };
    state[ "sheetFile" ] = "sub/power.kicad_sch";
    state[ "selection" ] = nlohmann::json::array();
    state[ "boxes" ] = nlohmann::json::array();
    state[ "ghost" ] = nlohmann::json::array();

    for( int ii = 0; ii < 400; ++ii )
    {
        state[ "selection" ].push_back( KIID().AsStdString() );
        state[ "boxes" ].push_back( { ii * 1000, ii * 1000, 500000, 500000 } );
        state[ "ghost" ].push_back( { ii, ii, ii + 10, ii + 10, 100000 } );
    }

    BOOST_REQUIRE( state.dump().size() > 8 * 1024 );

    COLLAB_SESSION::ClampPresence( state );

    BOOST_CHECK( state.dump().size() <= 8 * 1024 );
    BOOST_CHECK( state.contains( "cursor" ) );
    BOOST_CHECK( state[ "viewport" ].size() == 4 );

    // The receiver pairs a peer's selection ids with its boxes by index for live-drag ghosts,
    // so whatever survives has to stay aligned.
    BOOST_CHECK_EQUAL( state[ "selection" ].size(), state[ "boxes" ].size() );
}


// The "access withdrawn" false alarm.
//
// On hello_ok the session used to flip to LIVE first and re-send join_doc afterwards.
// setState() notifies the adapters synchronously and the tools replay their
// unacknowledged edits on LIVE, so on a reconnect those ops went out with `joined` still
// true from the previous socket -- ahead of the join_doc messages.  The server answered
// each with a permission_denied that carried no clientOpId, which the session read as the
// join itself being refused, and the editor told the user their access had been
// withdrawn while they were still the project's owner.
//
// Now: join_doc goes out first, SendOp holds until doc_info, the adapters replay from
// OnDocInfo, the server names the transient case not_joined, and an unscoped
// permission_denied only counts as a revocation while a join is actually pending.
BOOST_AUTO_TEST_CASE( ReconnectRejoinsBeforeReplayingAndDoesNotFakeARevocation )
{
    struct REPLAYING_ADAPTER : public COLLAB_DOC_ADAPTER
    {
        wxString docId;
        int      refusals = 0;

        void replay()
        {
            COLLAB_SESSION::Get().SendOp( docId, wxS( "op-replay" ), std::nullopt,
                                          nlohmann::json::array() );
        }

        // What the tools do: replay on LIVE (the old, racing place) and on OnDocInfo (the
        // new one).  Both are exercised; only the second may actually reach the wire.
        void OnSessionStateChanged() override
        {
            if( COLLAB_SESSION::Get().IsLive() )
                replay();
        }
        void OnDocInfo( const nlohmann::json& ) override { replay(); }
        void OnJoinRefused( const wxString&, const wxString& ) override { refusals++; }
    };

    COLLAB_SESSION&   session = COLLAB_SESSION::Get();
    REPLAYING_ADAPTER editor;
    editor.docId = wxS( "doc-reconnect" );

    std::vector<std::string> wire;   // message types in send order
    session.SetSendSinkForTests( [&]( const nlohmann::json& m ) { wire.push_back( m.value( "type", "" ) ); } );

    session.JoinDoc( editor.docId, std::nullopt, &editor );
    wire.clear();

    const nlohmann::json helloOk = { { "type", "hello_ok" }, { "clientId", "9:test" },
                                     { "userId", 9 }, { "login", "owner" } };
    const nlohmann::json docInfo = { { "type", "doc_info" }, { "docId", "doc-reconnect" },
                                     { "role", "editor" }, { "peers", nlohmann::json::array() } };

    // First connection: the join goes out, the LIVE-time replay is held, doc_info releases it.
    session.RouteMessageForTests( helloOk );
    BOOST_REQUIRE( !wire.empty() );
    BOOST_CHECK_EQUAL( wire.front(), "join_doc" );
    BOOST_CHECK( std::find( wire.begin(), wire.end(), "op" ) == wire.end() );
    session.RouteMessageForTests( docInfo );
    BOOST_CHECK( std::find( wire.begin(), wire.end(), "op" ) != wire.end() );

    // Reconnect with `joined` stale from the previous socket: join_doc must still precede
    // the replayed op.  (Before the fix the op was first, and got refused.)
    session.SetStateForTests( COLLAB_SESSION::STATE::CONNECTING );
    wire.clear();
    session.RouteMessageForTests( helloOk );
    BOOST_REQUIRE( !wire.empty() );
    BOOST_CHECK_EQUAL( wire.front(), "join_doc" );
    BOOST_CHECK( std::find( wire.begin(), wire.end(), "op" ) == wire.end() );
    session.RouteMessageForTests( docInfo );
    auto joinAt = std::find( wire.begin(), wire.end(), "join_doc" );
    auto opAt = std::find( wire.begin(), wire.end(), "op" );
    BOOST_REQUIRE( opAt != wire.end() );
    BOOST_CHECK( joinAt < opAt );

    // The server's honest answer to the race is not a revocation, and neither is an
    // unscoped permission_denied once the join has been confirmed.
    session.RouteMessageForTests( { { "type", "error" }, { "code", "not_joined" },
                                    { "docId", "doc-reconnect" } } );
    session.RouteMessageForTests( { { "type", "error" }, { "code", "permission_denied" },
                                    { "docId", "doc-reconnect" } } );
    BOOST_CHECK_EQUAL( editor.refusals, 0 );
    wire.clear();
    editor.replay();
    BOOST_CHECK( !wire.empty() );   // still joined: edits still flow

    // A real refusal -- unscoped permission_denied while the join is pending -- still lands.
    session.SetStateForTests( COLLAB_SESSION::STATE::CONNECTING );
    session.RouteMessageForTests( helloOk );
    session.RouteMessageForTests( { { "type", "error" }, { "code", "permission_denied" },
                                    { "docId", "doc-reconnect" } } );
    BOOST_CHECK_EQUAL( editor.refusals, 1 );
    wire.clear();
    editor.replay();
    BOOST_CHECK( wire.empty() );    // refused: nothing goes out

    session.LeaveDoc( editor.docId );
    session.SetSendSinkForTests( nullptr );
    session.SetStateForTests( COLLAB_SESSION::STATE::DISCONNECTED );
    session.SetProjectId( wxEmptyString );
    session.SetProjectDocs( nlohmann::json::array() );
}


// ---- Remote op application ------------------------------------------------------------------
//
// ApplyRemoteOp applies a remote op in one commit and re-asserts this client's provably newer
// own edits over the items it touched (last writer wins), then frees what the commit removed.
// The 1.0.6 crash on reopening a project came from freeing what was *asked* to be removed
// instead: a remote deletion re-asserted over by an own upsert leaves the item on the sheet,
// and freeing it anyway left a dead pointer in the screen's RTree for the next sheet plot.

BOOST_AUTO_TEST_CASE( RemoteRemoveOverriddenByOwnUpsertKeepsTheItemAlive )
{
    SCH_SHEET_PATH pathA;
    SCH_SYMBOL*    subject = FindAnySymbol( *m_authoring, &pathA );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    KIID id = subject->m_Uuid;

    // Our own newer edit: a whole-item upsert of the symbol at a new position (what a move
    // journals when no property-level delta describes it).
    VECTOR2I newPos = subject->GetPosition() + VECTOR2I( 2540, -2540 );
    subject->SetPosition( newPos );

    nlohmann::json own = nlohmann::json::array();
    own.push_back( MakeChange( subject, "ADDED" ) );
    own.back()[ "sexpr" ] = SCH_COLLAB::FormatItemSexpr( *m_authoring, pathA.LastScreen(),
                                                          subject );

    // The older remote op deletes that same item.
    nlohmann::json remote = nlohmann::json::array();
    remote.push_back( MakeChange( subject, "REMOVED" ) );

    TOOL_MANAGER                       toolMgr;
    std::vector<const nlohmann::json*> newerOwn{ &own };

    SCH_COLLAB::ApplyRemoteOp( *m_receiving, screenB, remote, newerOwn, &toolMgr );

    // Last writer wins: the upsert stands, so the item is still on the sheet -- the same
    // live object, at our position -- and nothing on the sheet is a freed object.
    SCH_ITEM* survivor = FindTwin( *m_receiving, id, nullptr );
    BOOST_REQUIRE( survivor );
    BOOST_CHECK( survivor == twin );
    BOOST_CHECK( screenB->CheckIfOnDrawList( twin ) );
    BOOST_CHECK_EQUAL( survivor->GetPosition().x, newPos.x );
    BOOST_CHECK_EQUAL( survivor->GetPosition().y, newPos.y );
    CheckEveryItemIsLive( screenB );
}


BOOST_AUTO_TEST_CASE( RemoteRemoveAndOwnRemoveOfTheSameItemFreeItOnce )
{
    SCH_SYMBOL* subject = FindAnySymbol( *m_authoring, nullptr );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    KIID id = subject->m_Uuid;

    // Both sides deleted it; ours is still in flight when the remote deletion lands, so the
    // same live object is asked to go twice.  It must be freed exactly once (a double free
    // here aborts the process).
    nlohmann::json own = nlohmann::json::array();
    own.push_back( MakeChange( subject, "REMOVED" ) );

    nlohmann::json remote = nlohmann::json::array();
    remote.push_back( MakeChange( subject, "REMOVED" ) );

    TOOL_MANAGER                       toolMgr;
    std::vector<const nlohmann::json*> newerOwn{ &own };

    SCH_COLLAB::ApplyRemoteOp( *m_receiving, screenB, remote, newerOwn, &toolMgr );

    BOOST_CHECK( FindTwin( *m_receiving, id, nullptr ) == nullptr );
    CheckEveryItemIsLive( screenB );
}


BOOST_AUTO_TEST_CASE( RemoteRemoveWinsOverOwnPropertyEdit )
{
    SCH_SHEET_PATH pathA;
    SCH_SYMBOL*    subject = FindAnySymbol( *m_authoring, &pathA );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    KIID id = subject->m_Uuid;

    // Our own newer edit is a property-level move...
    VECTOR2I newPos = subject->GetPosition() + VECTOR2I( 5000, 2500 );
    subject->SetPosition( newPos );

    std::vector<PROPERTY_DELTA> deltas;

    {
        SHEET_SCOPE scopeA( m_authoring.get(), &pathA );
        deltas = DiffItemProperties( twin, subject );
    }

    BOOST_REQUIRE( !deltas.empty() );

    nlohmann::json own = nlohmann::json::array();
    own.push_back( MakeChange( subject, "MODIFIED" ) );

    for( const PROPERTY_DELTA& delta : deltas )
        own.back()[ "properties" ].push_back( delta.ToJson() );

    own = nlohmann::json::parse( own.dump() );

    // ...over an older remote deletion.  Every other client applies the deletion and then
    // finds nothing to move, so the deletion has to win here as well -- and the item must
    // not be left on the sheet as a freed object.
    nlohmann::json remote = nlohmann::json::array();
    remote.push_back( MakeChange( subject, "REMOVED" ) );

    TOOL_MANAGER                       toolMgr;
    std::vector<const nlohmann::json*> newerOwn{ &own };

    SCH_COLLAB::ApplyRemoteOp( *m_receiving, screenB, remote, newerOwn, &toolMgr );

    BOOST_CHECK( FindTwin( *m_receiving, id, nullptr ) == nullptr );
    CheckEveryItemIsLive( screenB );
}


BOOST_AUTO_TEST_CASE( OwnRemoveWinsOverRemoteReAddOfTheSameItem )
{
    SCH_SHEET_PATH pathA;
    SCH_SYMBOL*    subject = FindAnySymbol( *m_authoring, &pathA );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   twin = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( twin );

    KIID id = subject->m_Uuid;

    // We deleted it (our REMOVED is the newer op, still in flight)...
    screenB->Remove( twin );
    delete twin;

    nlohmann::json own = nlohmann::json::array();
    own.push_back( MakeChange( subject, "REMOVED" ) );

    // ...while an older remote op re-adds it in full.
    nlohmann::json remote = nlohmann::json::array();
    remote.push_back( MakeChange( subject, "ADDED" ) );
    remote.back()[ "sexpr" ] = SCH_COLLAB::FormatItemSexpr( *m_authoring, pathA.LastScreen(),
                                                             subject );

    TOOL_MANAGER                       toolMgr;
    std::vector<const nlohmann::json*> newerOwn{ &own };

    SCH_COLLAB::ApplyRemoteOp( *m_receiving, screenB, remote, newerOwn, &toolMgr );

    // The re-add is only staged, not yet on the sheet, when our deletion is re-asserted;
    // it must still be dropped, or the item came back on this side only.
    BOOST_CHECK( FindTwin( *m_receiving, id, nullptr ) == nullptr );
    CheckEveryItemIsLive( screenB );
}


// The ops since a snapshot are folded into the parsed snapshot copy before the merge.  That
// copy is a detached scratch screen: the fold must resolve items inside it, never through the
// hierarchy, which knows only the live sheet and has items of the very same KIIDs.
BOOST_AUTO_TEST_CASE( SnapshotOpsFoldIntoTheScratchScreenOnly )
{
    SCH_SHEET_PATH pathA;
    SCH_SYMBOL*    subject = FindAnySymbol( *m_authoring, &pathA );
    BOOST_REQUIRE( subject );

    SCH_SCREEN* screenB = nullptr;
    SCH_ITEM*   live = FindTwin( *m_receiving, subject->m_Uuid, &screenB );
    BOOST_REQUIRE( live );

    KIID     id = subject->m_Uuid;
    VECTOR2I livePos = live->GetPosition();

    // The scratch copy: the item parsed into a screen the hierarchy knows nothing about.
    SCH_SHEET   scratchSheet;
    SCH_SCREEN* scratch = new SCH_SCREEN( m_receiving.get() );
    scratchSheet.SetScreen( scratch );

    wxString error;
    BOOST_REQUIRE_MESSAGE(
            SCH_COLLAB::ParseIntoScreen(
                    SCH_COLLAB::FormatItemSexpr( *m_authoring, pathA.LastScreen(), subject ),
                    scratchSheet, &error ),
            error );

    auto inScratch = [&]() -> SCH_ITEM*
    {
        for( SCH_ITEM* item : scratch->Items() )
        {
            if( item->m_Uuid == id )
                return item;
        }

        return nullptr;
    };

    BOOST_REQUIRE( inScratch() );

    // A server-side deletion folded into the scratch copy leaves the live sheet alone...
    nlohmann::json removal = MakeChange( subject, "REMOVED" );
    BOOST_REQUIRE( SCH_COLLAB::ApplyItemChange( *m_receiving, scratch, removal, nullptr, true ) );
    BOOST_CHECK( inScratch() == nullptr );
    BOOST_CHECK( FindTwin( *m_receiving, id, nullptr ) == live );
    BOOST_CHECK( screenB->CheckIfOnDrawList( live ) );

    // ...and a server-side upsert lands in the scratch copy, not on the live item.
    VECTOR2I moved = subject->GetPosition() + VECTOR2I( 5080, 0 );
    subject->SetPosition( moved );

    nlohmann::json upsert = MakeChange( subject, "ADDED" );
    upsert[ "sexpr" ] = SCH_COLLAB::FormatItemSexpr( *m_authoring, pathA.LastScreen(), subject );

    BOOST_REQUIRE( SCH_COLLAB::ApplyItemChange( *m_receiving, scratch, upsert, nullptr, true ) );

    SCH_ITEM* rebuilt = inScratch();
    BOOST_REQUIRE( rebuilt );
    BOOST_CHECK_EQUAL( rebuilt->GetPosition().x, moved.x );
    BOOST_CHECK_EQUAL( rebuilt->GetPosition().y, moved.y );
    BOOST_CHECK_EQUAL( live->GetPosition().x, livePos.x );
    BOOST_CHECK_EQUAL( live->GetPosition().y, livePos.y );
    CheckEveryItemIsLive( screenB );
}


BOOST_AUTO_TEST_SUITE_END()
