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

#include <boost/test/unit_test.hpp>

#include <collab/collab_outbox.h>
#include <collab/collab_project.h>
#include <wx/ffile.h>
#include <wx/filename.h>
#include <wx/utils.h>

namespace
{

/// A scratch directory tree removed on destruction.
struct SCRATCH_DIR
{
    SCRATCH_DIR( const wxString& aTag )
    {
        wxFileName dir( wxFileName::GetTempDir(), wxEmptyString );
        dir.AppendDir( wxString::Format( wxS( "kicad-collab-qa-%s-%ld" ), aTag,
                                         (long) wxGetProcessId() ) );
        path = dir.GetPath();
        wxFileName::Mkdir( path, wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL );
    }

    ~SCRATCH_DIR() { wxFileName::Rmdir( path, wxPATH_RMDIR_RECURSIVE ); }

    wxString path;
};

/// Lay out a fake local copy: <root>/<name>/<name>.kicad_pro plus the
/// .collab/link.json binding it to aProjectId.
wxString makeLocalCopy( const wxString& aRoot, const wxString& aName,
                        const wxString& aProjectId )
{
    wxFileName dir( aRoot, wxEmptyString );
    dir.AppendDir( aName );
    wxFileName::Mkdir( dir.GetPath(), wxS_DIR_DEFAULT, wxPATH_MKDIR_FULL );

    wxFileName pro( dir.GetPath(), aName + wxS( ".kicad_pro" ) );

    wxFFile out( pro.GetFullPath(), wxS( "w" ) );
    out.Write( wxS( "{}" ) );
    out.Close();

    COLLAB_PROJECT::WriteLocalLink( dir.GetPath(), aName, wxS( "http://server.test" ),
                                    aProjectId );

    return pro.GetFullPath();
}

} // namespace


BOOST_AUTO_TEST_SUITE( CollabProjectRegistry )


BOOST_AUTO_TEST_CASE( RoundTrip )
{
    SCRATCH_DIR registry( wxS( "reg" ) );
    SCRATCH_DIR projects( wxS( "proj" ) );

    wxString pro = makeLocalCopy( projects.path, wxS( "Widget" ), wxS( "proj-1" ) );

    BOOST_CHECK( COLLAB_PROJECT::FindLocalCopyIn( registry.path, wxS( "proj-1" ) ).IsEmpty() );

    COLLAB_PROJECT::RecordLocalCopyIn( registry.path, wxS( "proj-1" ), pro );

    BOOST_CHECK_EQUAL( COLLAB_PROJECT::FindLocalCopyIn( registry.path, wxS( "proj-1" ) ), pro );

    // A second project records alongside without clobbering the first.
    wxString pro2 = makeLocalCopy( projects.path, wxS( "Gadget" ), wxS( "proj-2" ) );
    COLLAB_PROJECT::RecordLocalCopyIn( registry.path, wxS( "proj-2" ), pro2 );

    BOOST_CHECK_EQUAL( COLLAB_PROJECT::FindLocalCopyIn( registry.path, wxS( "proj-1" ) ), pro );
    BOOST_CHECK_EQUAL( COLLAB_PROJECT::FindLocalCopyIn( registry.path, wxS( "proj-2" ) ), pro2 );
}


BOOST_AUTO_TEST_CASE( GoneOrRepurposedCopiesAreNotReused )
{
    SCRATCH_DIR registry( wxS( "reg" ) );
    SCRATCH_DIR projects( wxS( "proj" ) );

    // Recorded but deleted from disk.
    wxString pro = makeLocalCopy( projects.path, wxS( "Widget" ), wxS( "proj-1" ) );
    COLLAB_PROJECT::RecordLocalCopyIn( registry.path, wxS( "proj-1" ), pro );
    wxRemoveFile( pro );

    BOOST_CHECK( COLLAB_PROJECT::FindLocalCopyIn( registry.path, wxS( "proj-1" ) ).IsEmpty() );

    // Recorded, still on disk, but the directory is now linked to a different
    // project: must not be silently reused.
    wxString pro2 = makeLocalCopy( projects.path, wxS( "Gadget" ), wxS( "proj-other" ) );
    COLLAB_PROJECT::RecordLocalCopyIn( registry.path, wxS( "proj-2" ), pro2 );

    BOOST_CHECK( COLLAB_PROJECT::FindLocalCopyIn( registry.path, wxS( "proj-2" ) ).IsEmpty() );
}


BOOST_AUTO_TEST_CASE( CorruptRegistryRecovers )
{
    SCRATCH_DIR registry( wxS( "reg" ) );
    SCRATCH_DIR projects( wxS( "proj" ) );

    {
        wxFFile out( wxFileName( registry.path, wxS( "collab-local-copies.json" ) )
                             .GetFullPath(),
                     wxS( "w" ) );
        out.Write( wxS( "not json {{{" ) );
    }

    BOOST_CHECK( COLLAB_PROJECT::FindLocalCopyIn( registry.path, wxS( "proj-1" ) ).IsEmpty() );

    wxString pro = makeLocalCopy( projects.path, wxS( "Widget" ), wxS( "proj-1" ) );
    COLLAB_PROJECT::RecordLocalCopyIn( registry.path, wxS( "proj-1" ), pro );

    BOOST_CHECK_EQUAL( COLLAB_PROJECT::FindLocalCopyIn( registry.path, wxS( "proj-1" ) ), pro );
}


BOOST_AUTO_TEST_SUITE_END()


// ---- Working without a connection -----------------------------------------------------------

BOOST_AUTO_TEST_SUITE( CollabOffline )


// A copy opened with no server in reach starts its session from what the server said about
// the project last time.  Only what a session needs is kept, and only for the project the
// folder is linked to.
BOOST_AUTO_TEST_CASE( CachedProjectStartsASessionWithoutTheServer )
{
    SCRATCH_DIR projects( wxS( "cached" ) );

    wxFileName pro( makeLocalCopy( projects.path, wxS( "Widget" ), wxS( "proj-1" ) ) );

    BOOST_CHECK( !COLLAB_PROJECT::ReadCachedProject( pro.GetPath(), wxS( "Widget" ),
                                                     wxS( "proj-1" ) ) );

    const nlohmann::json fromServer = {
        { "projectId", "proj-1" },
        { "name", "Widget" },
        { "ownerId", 7 },
        { "role", "owner" },
        { "members", { { { "email", "someone@example.test" } } } },
        { "docs",
          { { { "docId", "d-sch" }, { "path", "Widget.kicad_sch" }, { "docType", "kicad_sch" } },
            { { "docId", "d-pcb" }, { "path", "Widget.kicad_pcb" }, { "docType", "kicad_pcb" } } } },
    };

    COLLAB_PROJECT::WriteCachedProject( pro.GetPath(), wxS( "Widget" ), fromServer );

    std::optional<nlohmann::json> cached =
            COLLAB_PROJECT::ReadCachedProject( pro.GetPath(), wxS( "Widget" ), wxS( "proj-1" ) );

    BOOST_REQUIRE( cached );
    BOOST_CHECK_EQUAL( cached->value( "ownerId", 0 ), 7 );
    BOOST_REQUIRE_EQUAL( ( *cached )[ "docs" ].size(), 2 );
    BOOST_CHECK_EQUAL( ( *cached )[ "docs" ][ 1 ].value( "docId", "" ), "d-pcb" );
    BOOST_CHECK_EQUAL( ( *cached )[ "docs" ][ 1 ].value( "path", "" ), "Widget.kicad_pcb" );

    // Who else is on the project is the server's business, not this folder's.
    BOOST_CHECK( !cached->contains( "members" ) );

    // The folder was linked to another project since: the old description is not its.
    BOOST_CHECK( !COLLAB_PROJECT::ReadCachedProject( pro.GetPath(), wxS( "Widget" ),
                                                     wxS( "proj-2" ) ) );

    // A folder that is not a linked copy gets no file.
    SCRATCH_DIR plain( wxS( "plain" ) );
    COLLAB_PROJECT::WriteCachedProject( plain.path, wxS( "Widget" ), fromServer );
    BOOST_CHECK( !wxFileName::DirExists( plain.path + wxS( "/Widget.collab" ) ) );

    // Making the copy local again forgets it.
    COLLAB_PROJECT::UnlinkLocalProject( pro.GetPath(), wxS( "Widget" ) );
    BOOST_CHECK( !COLLAB_PROJECT::ReadCachedProject( pro.GetPath(), wxS( "Widget" ),
                                                     wxS( "proj-1" ) ) );
}


static nlohmann::json change( const char* aId, const char* aKind = "MODIFIED" )
{
    return { { "id", aId }, { "kind", aKind } };
}


// Edits made while the connection is down go out in the order they were made.  The old
// replay walked a map keyed by "<client>:<n>", so the tenth edit of an item went out
// before the ninth and the ninth is what everyone else ended up with.
BOOST_AUTO_TEST_CASE( OfflineEditsReplayInTheOrderTheyWereMade )
{
    COLLAB_OUTBOX outbox;

    for( int n = 1; n <= 12; ++n )
    {
        outbox.Push( wxS( "doc" ), wxString::Format( wxS( "c:%d" ), n ),
                     nlohmann::json::array( { change( "item" ) } ) );
    }

    std::vector<wxString> wire;

    outbox.Pump( [&]( const COLLAB_OUTBOX::OP& aOp )
                 {
                     wire.push_back( aOp.clientOpId );
                     return true;
                 } );

    BOOST_REQUIRE_EQUAL( wire.size(), 12 );

    for( int n = 1; n <= 12; ++n )
        BOOST_CHECK_EQUAL( wire[n - 1], wxString::Format( wxS( "c:%d" ), n ) );
}


// A long spell offline is not dumped on the socket in one go: a window of ops is in flight
// and each acknowledgement lets the next one out.  Losing the connection puts everything
// unacknowledged back in line, still in order.
BOOST_AUTO_TEST_CASE( ReplayIsWindowedAndSurvivesAnotherDrop )
{
    COLLAB_OUTBOX outbox;
    const int     total = static_cast<int>( COLLAB_OUTBOX::WINDOW ) + 20;

    for( int n = 1; n <= total; ++n )
    {
        outbox.Push( wxS( "doc" ), wxString::Format( wxS( "c:%d" ), n ),
                     nlohmann::json::array( { change( "item" ) } ) );
    }

    std::vector<wxString> wire;
    auto send = [&]( const COLLAB_OUTBOX::OP& aOp )
    {
        wire.push_back( aOp.clientOpId );
        return true;
    };

    BOOST_CHECK_EQUAL( outbox.Pump( send ), COLLAB_OUTBOX::WINDOW );
    BOOST_CHECK_EQUAL( outbox.Pump( send ), 0 );            // the window is full
    BOOST_CHECK_EQUAL( outbox.UnsentCount(), 20 );

    COLLAB_OUTBOX::OP acked;
    BOOST_CHECK( outbox.Ack( wxS( "c:1" ), &acked ) );
    BOOST_CHECK_EQUAL( acked.clientOpId, wxString( wxS( "c:1" ) ) );
    BOOST_CHECK( !outbox.Ack( wxS( "c:1" ) ) );              // only once
    BOOST_CHECK_EQUAL( outbox.Pump( send ), 1 );
    BOOST_CHECK_EQUAL( wire.back(),
                       wxString::Format( wxS( "c:%d" ), (int) COLLAB_OUTBOX::WINDOW + 1 ) );

    // The connection goes with a window in flight and comes back.
    outbox.MarkAllUnsent();
    wire.clear();

    BOOST_CHECK_EQUAL( outbox.Pump( send ), COLLAB_OUTBOX::WINDOW );
    BOOST_CHECK_EQUAL( wire.front(), wxString( wxS( "c:2" ) ) );         // oldest unacknowledged first
    BOOST_CHECK_EQUAL( outbox.Size(), total - 1 );
}


// Nothing of a document goes out before its catch-up is in, and an op that is held back
// holds back the later ops of its document -- but not those of another.
BOOST_AUTO_TEST_CASE( AHeldDocumentKeepsItsOrderAndBlocksNoOther )
{
    COLLAB_OUTBOX outbox;

    outbox.Push( wxS( "root" ), wxS( "c:1" ), nlohmann::json::array( { change( "a" ) } ) );
    outbox.Push( wxS( "sub" ), wxS( "c:2" ), nlohmann::json::array( { change( "b" ) } ) );
    outbox.Push( wxS( "root" ), wxS( "c:3" ), nlohmann::json::array( { change( "a" ) } ) );
    outbox.Push( wxS( "sub" ), wxS( "c:4" ), nlohmann::json::array( { change( "b" ) } ) );

    std::vector<wxString> wire;
    int                   asked = 0;

    outbox.Pump( [&]( const COLLAB_OUTBOX::OP& aOp )
                 {
                     asked++;

                     if( aOp.docId == wxS( "root" ) )
                         return false;      // not caught up yet

                     wire.push_back( aOp.clientOpId );
                     return true;
                 } );

    BOOST_CHECK_EQUAL( asked, 3 );           // c:3 was not even offered
    BOOST_REQUIRE_EQUAL( wire.size(), 2 );
    BOOST_CHECK_EQUAL( wire[0], wxString( wxS( "c:2" ) ) );
    BOOST_CHECK_EQUAL( wire[1], wxString( wxS( "c:4" ) ) );

    BOOST_CHECK_EQUAL( outbox.Count( wxS( "root" ) ), 2 );
    BOOST_CHECK_EQUAL( outbox.TouchedIds( wxS( "root" ) ).count( "a" ), 1 );
    BOOST_CHECK_EQUAL( outbox.TouchedIds( wxS( "root" ) ).count( "b" ), 0 );

    // A snapshot catch-up folds what is not on the wire into its merge instead.
    std::vector<COLLAB_OUTBOX::OP> folded = outbox.TakeUnsent( wxS( "root" ) );

    BOOST_REQUIRE_EQUAL( folded.size(), 2 );
    BOOST_CHECK_EQUAL( folded[0].clientOpId, wxString( wxS( "c:1" ) ) );
    BOOST_CHECK_EQUAL( outbox.Count( wxS( "root" ) ), 0 );
    BOOST_CHECK_EQUAL( outbox.Count( wxS( "sub" ) ), 2 );    // on the wire: stays

    outbox.Clear( wxS( "sub" ) );
    BOOST_CHECK( outbox.Empty() );
}


// A refill ships whole zones, megabytes on a dense board.  Refilling five times offline
// must not queue five copies: only the last fill of a zone matters.  Everything else in
// those ops stays, and a fill already on the wire is left alone.
BOOST_AUTO_TEST_CASE( OnlyTheLastOfflineRefillOfAZoneIsKept )
{
    COLLAB_OUTBOX outbox;

    auto fill = []( const char* aId, const char* aSexpr )
    {
        return nlohmann::json{ { "id", aId }, { "kind", "MODIFIED" }, { "zoneFill", true },
                               { "sexpr", aSexpr } };
    };

    outbox.Push( wxS( "doc" ), wxS( "c:1" ),
                 nlohmann::json::array( { fill( "z1", "fill-1" ), fill( "z2", "fill-1" ) } ) );
    outbox.Push( wxS( "doc" ), wxS( "c:2" ),
                 nlohmann::json::array( { change( "track", "ADDED" ), fill( "z1", "fill-2" ) } ) );
    outbox.Push( wxS( "doc" ), wxS( "c:3" ), nlohmann::json::array( { fill( "z1", "fill-3" ) } ) );

    // c:1 keeps z2 only, c:2 keeps the track only, c:3 holds z1's one remaining fill.
    BOOST_REQUIRE_EQUAL( outbox.Size(), 3 );
    BOOST_REQUIRE_EQUAL( outbox.Ops()[0].changes.size(), 1 );
    BOOST_CHECK_EQUAL( outbox.Ops()[0].changes[0].value( "id", "" ), "z2" );
    BOOST_REQUIRE_EQUAL( outbox.Ops()[1].changes.size(), 1 );
    BOOST_CHECK_EQUAL( outbox.Ops()[1].changes[0].value( "id", "" ), "track" );
    BOOST_CHECK_EQUAL( outbox.Ops()[2].changes[0].value( "sexpr", "" ), "fill-3" );

    // An op left with nothing in it is dropped.
    outbox.Push( wxS( "doc" ), wxS( "c:4" ), nlohmann::json::array( { fill( "z1", "fill-4" ) } ) );
    BOOST_REQUIRE_EQUAL( outbox.Size(), 3 );
    BOOST_CHECK_EQUAL( outbox.Ops()[2].clientOpId, wxString( wxS( "c:4" ) ) );

    // Once it is on the wire it is the server's to order; a later fill follows it.
    outbox.Pump( []( const COLLAB_OUTBOX::OP& ) { return true; } );
    outbox.Push( wxS( "doc" ), wxS( "c:5" ), nlohmann::json::array( { fill( "z1", "fill-5" ) } ) );
    BOOST_CHECK_EQUAL( outbox.Size(), 4 );

    // Another document's zones are another matter.
    outbox.Push( wxS( "other" ), wxS( "c:6" ), nlohmann::json::array( { fill( "z1", "x" ) } ) );
    outbox.Push( wxS( "doc" ), wxS( "c:7" ), nlohmann::json::array( { fill( "z9", "y" ) } ) );
    BOOST_CHECK_EQUAL( outbox.Count( wxS( "other" ) ), 1 );
}


// The op journal earlier versions left beside the project was replayed on the next run
// under a new client id; it is removed, not read.
BOOST_AUTO_TEST_CASE( LegacyJournalIsRemoved )
{
    SCRATCH_DIR projects( wxS( "journal" ) );

    wxFileName pro( makeLocalCopy( projects.path, wxS( "Widget" ), wxS( "proj-1" ) ) );
    wxFileName journal( pro.GetPath(), wxS( "oplog-board.ndjson" ) );
    journal.AppendDir( wxS( "Widget.collab" ) );

    {
        wxFFile out( journal.GetFullPath(), wxS( "w" ) );
        out.Write( wxS( "{\"docId\":\"d\",\"clientOpId\":\"c:1\",\"changes\":[]}\n" ) );
    }

    BOOST_REQUIRE( journal.FileExists() );

    COLLAB_OUTBOX::RemoveLegacyJournal( pro.GetPath(), wxS( "Widget" ),
                                        wxS( "oplog-board.ndjson" ) );

    BOOST_CHECK( !journal.FileExists() );

    // The link beside it is untouched.
    BOOST_CHECK( COLLAB_PROJECT::IsLinked( pro.GetPath(), wxS( "Widget" ) ) );
}


BOOST_AUTO_TEST_SUITE_END()
