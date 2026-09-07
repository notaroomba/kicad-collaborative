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
#include <collab/collab_session.h>

#include <diff_merge/kicad_diff_types.h>
#include <diff_merge/property_diff.h>

#include <board.h>
#include <footprint.h>
#include <netinfo.h>
#include <pad.h>
#include <pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h>
#include <generators_mgr.h>
#include <pcb_generator.h>
#include <pcb_group.h>
#include <pcb_track.h>
#include <richio.h>
#include <reporter.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/utils.h>
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


BOOST_AUTO_TEST_CASE( GroupMembershipTravels )
{
    // Two tracks exist on both boards; the author groups them.
    PCB_TRACK* twin1 = nullptr;
    PCB_TRACK* twin2 = nullptr;
    PCB_TRACK* track1 = MakeTrackPair( &twin1 );
    PCB_TRACK* track2 = MakeTrackPair( &twin2 );

    PCB_GROUP* group = new PCB_GROUP( m_authoring.get() );
    group->SetName( wxS( "power" ) );
    group->AddItem( track1 );
    group->AddItem( track2 );
    m_authoring->Add( group );

    nlohmann::json change = MakeChange( group, "ADDED" );
    change[ "sexpr" ] = PCB_COLLAB::FormatItemSexpr( group );
    change[ "groupMembers" ] = { track1->m_Uuid.AsStdString(), track2->m_Uuid.AsStdString() };

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    PCB_GROUP* applied =
            dynamic_cast<PCB_GROUP*>( m_receiving->ResolveItem( group->m_Uuid, true ) );

    BOOST_REQUIRE( applied != nullptr );
    BOOST_CHECK( applied->GetName() == wxS( "power" ) );
    BOOST_CHECK_EQUAL( applied->GetItems().size(), 2 );
    BOOST_CHECK( twin1->GetParentGroup() == applied );
    BOOST_CHECK( twin2->GetParentGroup() == applied );

    // Member removal travels as a whole-item replace with the shorter list.
    group->RemoveItem( track2 );
    change = MakeChange( group, "MODIFIED" );
    change[ "sexpr" ] = PCB_COLLAB::FormatItemSexpr( group );
    change[ "groupMembers" ] = { track1->m_Uuid.AsStdString() };

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    applied = dynamic_cast<PCB_GROUP*>( m_receiving->ResolveItem( group->m_Uuid, true ) );
    BOOST_REQUIRE( applied != nullptr );
    BOOST_CHECK_EQUAL( applied->GetItems().size(), 1 );
    BOOST_CHECK( twin2->GetParentGroup() == nullptr );

    // Group removal leaves the members on the board.
    change = MakeChange( group, "REMOVED" );
    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    BOOST_CHECK( m_receiving->ResolveItem( group->m_Uuid, true ) == nullptr );
    BOOST_CHECK( m_receiving->ResolveItem( twin1->m_Uuid, true ) == twin1 );

    // The members must not keep a back-pointer at the deleted group —
    // IsLocked() walks it and crashed a live receiver on exactly this.
    BOOST_CHECK( twin1->GetParentGroup() == nullptr );
    BOOST_CHECK( !twin1->IsLocked() );
}


BOOST_AUTO_TEST_CASE( GeneratorRoundTrips )
{
    // Tuning patterns are PCB_GROUP subclasses created through the generators
    // registry; they must survive the same sexpr + groupMembers transfer.
    PCB_TRACK* twin = nullptr;
    PCB_TRACK* track = MakeTrackPair( &twin );

    PCB_GENERATOR* gen = GENERATORS_MGR::Instance().CreateFromType( wxS( "meanders" ) );
    BOOST_REQUIRE( gen != nullptr );

    gen->SetLayer( F_Cu );
    gen->AddItem( track );
    m_authoring->Add( gen );

    nlohmann::json change = MakeChange( gen, "ADDED" );
    change[ "sexpr" ] = PCB_COLLAB::FormatItemSexpr( gen );
    change[ "groupMembers" ] = { track->m_Uuid.AsStdString() };

    BOOST_REQUIRE( !change[ "sexpr" ].get<std::string>().empty() );
    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    PCB_GENERATOR* applied =
            dynamic_cast<PCB_GENERATOR*>( m_receiving->ResolveItem( gen->m_Uuid, true ) );

    BOOST_REQUIRE( applied != nullptr );
    BOOST_CHECK( applied->GetGeneratorType() == gen->GetGeneratorType() );
    BOOST_CHECK_EQUAL( applied->GetItems().size(), 1 );
    BOOST_CHECK( twin->GetParentGroup() == applied );

    // Removal releases the member cleanly, like a plain group.
    change = MakeChange( gen, "REMOVED" );
    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );
    BOOST_CHECK( m_receiving->ResolveItem( gen->m_Uuid, true ) == nullptr );
    BOOST_CHECK( twin->GetParentGroup() == nullptr );
}


BOOST_AUTO_TEST_CASE( GroupWithMissingMemberIsGraceful )
{
    PCB_TRACK* twin = nullptr;
    PCB_TRACK* track = MakeTrackPair( &twin );

    // The second member exists only on the authoring board.
    PCB_TRACK* authorOnly = new PCB_TRACK( m_authoring.get() );
    authorOnly->SetStart( VECTOR2I( 5000000, 5000000 ) );
    authorOnly->SetEnd( VECTOR2I( 6000000, 5000000 ) );
    authorOnly->SetWidth( 250000 );
    authorOnly->SetLayer( F_Cu );
    m_authoring->Add( authorOnly );

    PCB_GROUP* group = new PCB_GROUP( m_authoring.get() );
    group->SetName( wxS( "partial" ) );
    group->AddItem( track );
    group->AddItem( authorOnly );
    m_authoring->Add( group );

    nlohmann::json change = MakeChange( group, "ADDED" );
    change[ "sexpr" ] = PCB_COLLAB::FormatItemSexpr( group );
    change[ "groupMembers" ] = { track->m_Uuid.AsStdString(),
                                 authorOnly->m_Uuid.AsStdString() };

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    PCB_GROUP* applied =
            dynamic_cast<PCB_GROUP*>( m_receiving->ResolveItem( group->m_Uuid, true ) );

    BOOST_REQUIRE( applied != nullptr );

    // The unknown member is skipped, the known one is grouped.
    BOOST_CHECK_EQUAL( applied->GetItems().size(), 1 );
    BOOST_CHECK( twin->GetParentGroup() == applied );
}


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


// KiCad Collaborative must not restamp the file format version on save: a
// project shared with a stock KiCad keeps the version it was opened with.
BOOST_AUTO_TEST_CASE( SaveKeepsFileFormatVersion )
{
    WX_STRING_REPORTER reporter;

    auto savedVersion = [&]( int aAtLoad ) -> std::string
    {
        m_authoring->SetFileFormatVersionAtLoad( aAtLoad );
        reporter.Clear();

        wxString           tmp = wxFileName::CreateTempFileName( wxS( "collab_ver" ) );
        PCB_IO_KICAD_SEXPR io;

        io.SetReporter( &reporter );
        io.SaveBoard( tmp, m_authoring.get() );

        wxFFile   file( tmp, wxS( "r" ) );
        wxString  content;
        file.ReadAll( &content );
        wxRemoveFile( tmp );

        int start = content.Find( wxS( "(version " ) );
        BOOST_REQUIRE( start != wxNOT_FOUND );
        return content.Mid( start + 9, content.Mid( start + 9 ).Find( ')' ) ).ToStdString();
    };

    // A file opened at the version stock KiCad 10.0 writes keeps that version, silently.
    BOOST_CHECK_EQUAL( savedVersion( 20260206 ), "20260206" );
    BOOST_CHECK( !reporter.HasMessage() );

    // A legacy-format import (small integer version) gets the current stamp.
    BOOST_CHECK( savedVersion( 2 ) != "2" );

    // Stock stamping on request.
    wxSetEnv( wxS( "KICAD_COLLAB_STAMP_VERSIONS" ), wxS( "1" ) );
    BOOST_CHECK( savedVersion( 20260206 ) != "20260206" );
    wxUnsetEnv( wxS( "KICAD_COLLAB_STAMP_VERSIONS" ) );
}


// The board editor's half of the shared-connection bug.
//
// A board opened beside a live schematic session joins the project's kicad_pcb document
// over the connection eeschema already made (PCB_COLLAB_TOOL::onTimer scans
// COLLAB_SESSION::ProjectDocs() for it).  eeschema's endSession() then called
// COLLAB_SESSION::Disconnect() unconditionally -- on File > Leave Session, on "Make local
// only", and on simply closing the schematic window -- which destroyed the socket under
// the board editor.  pcbnew was never told: its own recovery in onTimer is gated on
// !m_ownsSession, so a board that had begun the session sat at "Collaboration: offline"
// with Leave Session enabled and no way back.
//
// The connection is now released only when the last document leaves it.
BOOST_AUTO_TEST_CASE( SchematicLeavingDoesNotStrandTheBoard )
{
    struct STUB_ADAPTER : public COLLAB_DOC_ADAPTER {};

    STUB_ADAPTER    schematicEditor;
    STUB_ADAPTER    boardEditor;
    COLLAB_SESSION& session = COLLAB_SESSION::Get();

    const wxString projectId = wxS( "5eaf00d0-9999-8888-7777-666655554444" );

    session.SetProjectId( projectId );
    session.JoinDoc( wxS( "doc-sch" ), std::nullopt, &schematicEditor );
    session.JoinDoc( wxS( "doc-pcb" ), std::nullopt, &boardEditor );

    session.LeaveDoc( wxS( "doc-sch" ) );

    BOOST_CHECK( !session.ReleaseIfIdle() );
    BOOST_CHECK_EQUAL( session.ProjectId(), projectId );

    // And when the board leaves as well, the session's identity goes with it: nothing is
    // left for File > Copy Share Link or File > History to act on.
    session.LeaveDoc( wxS( "doc-pcb" ) );

    BOOST_CHECK( session.ReleaseIfIdle() );
    BOOST_CHECK( session.ProjectId().IsEmpty() );
    BOOST_CHECK( session.GetState() == COLLAB_SESSION::STATE::DISCONNECTED );
}



// A footprint fragment is silent about pad nets (they are parsed with no board attached and
// arrive orphaned), so a change with no "padNets" must not be read as "clear every net": the
// receiver's ratsnest for that part would vanish and DRC would call its pads unconnected —
// permanently, once the board is saved.
BOOST_AUTO_TEST_CASE( FootprintChangeWithoutPadNetsKeepsExistingNets )
{
    FOOTPRINT* fp = new FOOTPRINT( m_authoring.get() );
    fp->SetPosition( VECTOR2I( 4000000, 6000000 ) );
    fp->SetReference( wxS( "U9" ) );

    PAD* pad = new PAD( fp );
    pad->SetNumber( wxS( "1" ) );
    pad->SetNetCode( 1 );       // GND on the authoring board
    fp->Add( pad );
    m_authoring->Add( fp );

    FOOTPRINT* twin = static_cast<FOOTPRINT*>( fp->Clone() );
    const_cast<KIID&>( twin->m_Uuid ) = fp->m_Uuid;
    m_receiving->Add( twin );
    twin->Pads().front()->SetNetCode( 2 );   // GND under the receiver's numbering

    BOOST_REQUIRE_EQUAL( twin->Pads().front()->GetNetname().ToStdString(), "GND" );

    const wxString netBefore = twin->Pads().front()->GetNetname();

    // The author drags the reference text: position changes, nets are not mentioned.
    fp->SetPosition( VECTOR2I( 9000000, 9500000 ) );

    FOOTPRINT* footprint = fp;

    // Exactly what the browser's canvas layer used to send: sexpr only.
    nlohmann::json change = MakeChange( footprint, "MODIFIED" );
    change[ "sexpr" ] = PCB_COLLAB::FormatItemSexpr( footprint );

    BOOST_REQUIRE( PCB_COLLAB::ApplyItemChange( m_receiving.get(), change, nullptr ) );

    FOOTPRINT* applied =
            dynamic_cast<FOOTPRINT*>( m_receiving->ResolveItem( footprint->m_Uuid, true ) );
    BOOST_REQUIRE( applied );
    BOOST_REQUIRE( !applied->Pads().empty() );

    BOOST_CHECK( applied->Pads().front()->GetNetname() == netBefore );
    BOOST_CHECK( applied->Pads().front()->GetNetCode() > 0 );
}


BOOST_AUTO_TEST_SUITE_END()
