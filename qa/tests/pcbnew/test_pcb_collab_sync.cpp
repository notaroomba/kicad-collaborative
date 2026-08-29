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

/**
 * Wire-format invariants of the PCB live-collaboration sync (collab/pcb_collab_sync):
 * property deltas, sexpr add round-trips with KIID preservation, name-based net
 * re-resolution, LWW delete semantics and upsert-replace.  The BOARD_COMMIT-staged
 * path is exercised manually; these cover the frame-free applier.
 */

#include <boost/test/unit_test.hpp>

#include <collab/pcb_collab_sync.h>

#include <diff_merge/kicad_diff_types.h>
#include <diff_merge/property_diff.h>

#include <board.h>
#include <footprint.h>
#include <netinfo.h>
#include <pad.h>
#include <pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h>
#include <pcb_track.h>
#include <richio.h>
#include <zone.h>

#include <nlohmann/json.hpp>

using namespace KICAD_DIFF;


struct PCB_COLLAB_SYNC_FIXTURE
{
    PCB_COLLAB_SYNC_FIXTURE() :
            m_authoring( std::make_unique<BOARD>() ),
            m_receiving( std::make_unique<BOARD>() )
    {
        // The same net on both boards, deliberately under different net codes, to
        // prove nets travel by name rather than by the author's local number.
        m_authoring->Add( new NETINFO_ITEM( m_authoring.get(), wxS( "GND" ), 1 ) );
        m_receiving->Add( new NETINFO_ITEM( m_receiving.get(), wxS( "SPARE" ), 1 ) );
        m_receiving->Add( new NETINFO_ITEM( m_receiving.get(), wxS( "GND" ), 2 ) );
    }

    ///< A track on the authoring board plus its twin (same KIID) on the receiver.
    PCB_TRACK* MakeTrackPair( PCB_TRACK** aTwinOut )
    {
        PCB_TRACK* track = new PCB_TRACK( m_authoring.get() );
        track->SetStart( VECTOR2I( 1000000, 2000000 ) );
        track->SetEnd( VECTOR2I( 3000000, 2000000 ) );
        track->SetWidth( 250000 );
        track->SetLayer( F_Cu );
        track->SetNetCode( 1 );     // GND on the authoring board
        m_authoring->Add( track );

        PCB_TRACK* twin = static_cast<PCB_TRACK*>( track->Clone() );
        const_cast<KIID&>( twin->m_Uuid ) = track->m_Uuid;
        twin->SetNetCode( 2 );      // GND under the receiver's numbering
        m_receiving->Add( twin );

        if( aTwinOut )
            *aTwinOut = twin;

        return track;
    }

    static nlohmann::json MakeChange( const BOARD_ITEM* aItem, const char* aKind )
    {
        nlohmann::json change;
        change[ "id" ] = aItem->m_Uuid.AsStdString();
        change[ "typeName" ] = aItem->GetClass().ToStdString();
        change[ "kind" ] = aKind;
        change[ "properties" ] = nlohmann::json::array();
        return change;
    }

    std::unique_ptr<BOARD> m_authoring;
    std::unique_ptr<BOARD> m_receiving;
};


BOOST_FIXTURE_TEST_SUITE( PcbCollabSync, PCB_COLLAB_SYNC_FIXTURE )


BOOST_AUTO_TEST_CASE( ModifiedPropertiesConverge )
{
    PCB_TRACK* twin = nullptr;
    PCB_TRACK* subject = MakeTrackPair( &twin );

    // Author edit: drag the endpoint.
    subject->SetEnd( VECTOR2I( 5000000, 4000000 ) );

    std::vector<PROPERTY_DELTA> deltas = DiffItemProperties( twin, subject );
    BOOST_REQUIRE( !deltas.empty() );

    nlohmann::json change = MakeChange( subject, "MODIFIED" );

    for( const PROPERTY_DELTA& delta : deltas )
        change[ "properties" ].push_back( delta.ToJson() );

    // Round-trip through text like the real wire does.
    change = nlohmann::json::parse( change.dump() );

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    BOOST_CHECK_EQUAL( twin->GetEnd().x, subject->GetEnd().x );
    BOOST_CHECK_EQUAL( twin->GetEnd().y, subject->GetEnd().y );
}


BOOST_AUTO_TEST_CASE( RemovedChangeConvergesAndIsIdempotent )
{
    PCB_TRACK* twin = nullptr;
    PCB_TRACK* subject = MakeTrackPair( &twin );
    KIID       id = subject->m_Uuid;

    nlohmann::json change = MakeChange( subject, "REMOVED" );

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );
    BOOST_CHECK( m_receiving->ResolveItem( id, true ) == nullptr );

    // A second delivery (or a delete racing a modify) must be a silent no-op.
    BOOST_CHECK( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );
}


BOOST_AUTO_TEST_CASE( AddedSexprRoundTripPreservesKiidAndResolvesNetByName )
{
    PCB_TRACK* subject = new PCB_TRACK( m_authoring.get() );
    subject->SetStart( VECTOR2I( 7000000, 1000000 ) );
    subject->SetEnd( VECTOR2I( 7000000, 9000000 ) );
    subject->SetWidth( 400000 );
    subject->SetLayer( B_Cu );
    subject->SetNetCode( 1 );       // GND, which is net 2 on the receiver
    m_authoring->Add( subject );

    KIID id = subject->m_Uuid;

    std::string sexpr = PCB_COLLAB::FormatItemSexpr( subject );
    BOOST_REQUIRE( !sexpr.empty() );

    nlohmann::json change = MakeChange( subject, "ADDED" );
    change[ "sexpr" ] = sexpr;
    change[ "netName" ] = "GND";

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    BOARD_ITEM* rebuilt = m_receiving->ResolveItem( id, true );
    BOOST_REQUIRE( rebuilt );

    // The KIID must survive the round trip (never rewritten on apply), the geometry
    // must match, and the net must resolve by NAME against the receiving board.
    BOOST_CHECK( rebuilt->m_Uuid == id );
    BOOST_CHECK_EQUAL( rebuilt->Type(), PCB_TRACE_T );

    PCB_TRACK* rebuiltTrack = static_cast<PCB_TRACK*>( rebuilt );
    BOOST_CHECK_EQUAL( rebuiltTrack->GetStart().x, subject->GetStart().x );
    BOOST_CHECK_EQUAL( rebuiltTrack->GetEnd().y, subject->GetEnd().y );
    BOOST_CHECK_EQUAL( rebuiltTrack->GetWidth(), subject->GetWidth() );
    BOOST_CHECK_EQUAL( rebuiltTrack->GetNetCode(), 2 );
    BOOST_CHECK_EQUAL( rebuiltTrack->GetNetname().ToStdString(), "GND" );
}


BOOST_AUTO_TEST_CASE( AddedWithExistingUuidUpserts )
{
    PCB_TRACK* twin = nullptr;
    PCB_TRACK* subject = MakeTrackPair( &twin );

    subject->SetWidth( 990000 );

    std::string sexpr = PCB_COLLAB::FormatItemSexpr( subject );
    BOOST_REQUIRE( !sexpr.empty() );

    nlohmann::json change = MakeChange( subject, "ADDED" );
    change[ "sexpr" ] = sexpr;
    change[ "netName" ] = "GND";

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    BOARD_ITEM* replaced = m_receiving->ResolveItem( subject->m_Uuid, true );
    BOOST_REQUIRE( replaced );

    // Upsert-replace swaps data into the existing live object.
    BOOST_CHECK( replaced == twin );
    BOOST_CHECK_EQUAL( twin->GetWidth(), 990000 );
}


BOOST_AUTO_TEST_CASE( FootprintSexprRoundTripKeepsPadsAndNets )
{
    FOOTPRINT* fp = new FOOTPRINT( m_authoring.get() );
    fp->SetPosition( VECTOR2I( 4000000, 6000000 ) );
    fp->SetReference( wxS( "R42" ) );

    PAD* pad = new PAD( fp );
    pad->SetNumber( wxS( "1" ) );
    pad->SetNetCode( 1 );       // GND on the authoring board
    fp->Add( pad );

    m_authoring->Add( fp );

    KIID id = fp->m_Uuid;

    std::string sexpr = PCB_COLLAB::FormatItemSexpr( fp );
    BOOST_REQUIRE( !sexpr.empty() );

    nlohmann::json change = MakeChange( fp, "ADDED" );
    change[ "sexpr" ] = sexpr;
    change[ "padNets" ] = { { "1", "GND" } };

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    BOARD_ITEM* rebuilt = m_receiving->ResolveItem( id, true );
    BOOST_REQUIRE( rebuilt );
    BOOST_REQUIRE_EQUAL( rebuilt->Type(), PCB_FOOTPRINT_T );

    FOOTPRINT* rebuiltFp = static_cast<FOOTPRINT*>( rebuilt );
    BOOST_CHECK( rebuiltFp->m_Uuid == id );
    BOOST_CHECK_EQUAL( rebuiltFp->GetPosition().x, 4000000 );
    BOOST_CHECK_EQUAL( rebuiltFp->GetReference().ToStdString(), "R42" );
    BOOST_REQUIRE_EQUAL( rebuiltFp->Pads().size(), 1 );

    // Pad nets travel by name and resolve against the receiver's numbering.
    BOOST_CHECK_EQUAL( rebuiltFp->Pads().front()->GetNetCode(), 2 );
    BOOST_CHECK_EQUAL( rebuiltFp->Pads().front()->GetNetname().ToStdString(), "GND" );
}


BOOST_AUTO_TEST_CASE( FootprintUpsertReplacesInPlace )
{
    FOOTPRINT* fp = new FOOTPRINT( m_authoring.get() );
    fp->SetPosition( VECTOR2I( 4000000, 6000000 ) );
    fp->SetReference( wxS( "U7" ) );

    PAD* pad = new PAD( fp );
    pad->SetNumber( wxS( "1" ) );
    pad->SetNetCode( 1 );
    fp->Add( pad );

    m_authoring->Add( fp );

    FOOTPRINT* twin = static_cast<FOOTPRINT*>( fp->Clone() );
    const_cast<KIID&>( twin->m_Uuid ) = fp->m_Uuid;
    m_receiving->Add( twin );

    // Author moves the footprint; the wire carries a whole-item replace.
    fp->SetPosition( VECTOR2I( 9000000, 9500000 ) );

    std::string sexpr = PCB_COLLAB::FormatItemSexpr( fp );
    BOOST_REQUIRE( !sexpr.empty() );

    nlohmann::json change = MakeChange( fp, "ADDED" );
    change[ "sexpr" ] = sexpr;
    change[ "padNets" ] = { { "1", "GND" } };

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    BOARD_ITEM* replaced = m_receiving->ResolveItem( fp->m_Uuid, true );
    BOOST_REQUIRE( replaced );
    BOOST_CHECK( replaced == twin );
    BOOST_CHECK_EQUAL( replaced->GetPosition().x, 9000000 );
    BOOST_CHECK_EQUAL( replaced->GetPosition().y, 9500000 );

    // Regression: the replacement footprint must carry no pointers into the
    // temporary parse board (nets, component classes) — saving would crash.
    STRING_FORMATTER   formatter;
    PCB_IO_KICAD_SEXPR io;
    BOOST_CHECK_NO_THROW( io.FormatBoardToFormatter( &formatter, m_receiving.get(), nullptr ) );
    BOOST_CHECK( !formatter.GetString().empty() );
}


BOOST_AUTO_TEST_CASE( ZoneSexprShipsUnfilled )
{
    ZONE* zone = new ZONE( m_authoring.get() );
    zone->SetLayer( F_Cu );
    zone->Outline()->NewOutline();
    zone->Outline()->Append( VECTOR2I( 0, 0 ) );
    zone->Outline()->Append( VECTOR2I( 1000000, 0 ) );
    zone->Outline()->Append( VECTOR2I( 1000000, 1000000 ) );
    zone->SetNetCode( 1 );
    m_authoring->Add( zone );

    KIID id = zone->m_Uuid;

    std::string sexpr = PCB_COLLAB::FormatItemSexpr( zone );
    BOOST_REQUIRE( !sexpr.empty() );

    nlohmann::json change = MakeChange( zone, "ADDED" );
    change[ "sexpr" ] = sexpr;
    change[ "netName" ] = "GND";

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    BOARD_ITEM* rebuilt = m_receiving->ResolveItem( id, true );
    BOOST_REQUIRE( rebuilt );
    BOOST_REQUIRE_EQUAL( rebuilt->Type(), PCB_ZONE_T );

    ZONE* rebuiltZone = static_cast<ZONE*>( rebuilt );

    // Fills are local derived state: the wire ships the outline only and the
    // receiver's copy is marked for refill.
    BOOST_CHECK( !rebuiltZone->IsFilled() );
    BOOST_CHECK( rebuiltZone->NeedRefill() );
    BOOST_CHECK_EQUAL( rebuiltZone->Outline()->FullPointCount(), 3 );
}


BOOST_AUTO_TEST_SUITE_END()
