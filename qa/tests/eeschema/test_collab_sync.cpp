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
#include <sch_screen.h>
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


BOOST_AUTO_TEST_SUITE_END()
