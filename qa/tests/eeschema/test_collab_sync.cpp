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

#include <qa_utils/wx_utils/unit_test_utils.h>
#include <schematic_utils/schematic_file_util.h>

#include <collab/sch_collab_sync.h>

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
#include <sch_symbol.h>
#include <settings/settings_manager.h>

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
// project shared with a stock KiCad keeps the version it was opened with.
BOOST_AUTO_TEST_CASE( SaveKeepsFileFormatVersion )
{
    SCH_SHEET*  root = &m_authoring->Root();
    SCH_SCREEN* screen = root->GetScreen();
    BOOST_REQUIRE( screen );

    auto savedVersion = [&]( int aAtLoad ) -> std::string
    {
        screen->SetFileFormatVersionAtLoad( aAtLoad );

        wxString tmp = wxFileName::CreateTempFileName( wxS( "collab_ver" ) );
        SCH_IO_KICAD_SEXPR().SaveSchematicFile( tmp, root, m_authoring.get() );

        wxFFile   file( tmp, wxS( "r" ) );
        wxString  content;
        file.ReadAll( &content );
        wxRemoveFile( tmp );

        int start = content.Find( wxS( "(version " ) );
        BOOST_REQUIRE( start != wxNOT_FOUND );
        return content.Mid( start + 9, content.Mid( start + 9 ).Find( ')' ) ).ToStdString();
    };

    // A file opened at an older (stock KiCad) version keeps that version.
    BOOST_CHECK_EQUAL( savedVersion( 20241209 ), "20241209" );

    // A legacy-format import (small integer version) gets the current stamp.
    BOOST_CHECK( savedVersion( 2 ) != "2" );

    // Stock stamping on request.
    wxSetEnv( wxS( "KICAD_COLLAB_STAMP_VERSIONS" ), wxS( "1" ) );
    BOOST_CHECK( savedVersion( 20241209 ) != "20241209" );
    wxUnsetEnv( wxS( "KICAD_COLLAB_STAMP_VERSIONS" ) );
}


BOOST_AUTO_TEST_SUITE_END()
