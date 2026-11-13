/*
 * This program source code file is part of KiCad, a free EDA CAD application.
 *
 * Copyright The KiCad Developers, see AUTHORS.txt for contributors.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
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
 * Real boards from every KiCad release since 6.0, opened and saved the way the editor saves them.
 *
 * A board from KiCad 9 or 10 must come back at the version it was read at, so that release keeps
 * opening it.  An older board may be raised (the writer has no KiCad 8 grammar), but only with a
 * message saying so.  Either way the saved file must load again with the same contents, and a
 * second save must not change it.  A board from a newer KiCad that only uses things this build
 * knows must open.
 *
 * Set KICAD_ROUNDTRIP_OUT to a directory to keep each saved file there, for opening in a stock
 * KiCad of the matching release.
 */

#include <boost/test/unit_test.hpp>

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>

#include <wx/filename.h>

#include <board.h>
#include <footprint.h>
#include <pcb_track.h>
#include <zone.h>
#include <reporter.h>
#include <ki_exception.h>
#include <io/kicad/kicad_io_utils.h>
#include <pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h>
#include <pcbnew_utils/board_file_utils.h>


namespace
{

/// The oldest board version a stock release still reads that Junction writes back unchanged.
constexpr int KICAD9_BOARD_VERSION = 20241229;

struct SAMPLE
{
    const char* m_path;      ///< relative to qa/data/pcbnew
    const char* m_release;   ///< the KiCad release that wrote it
};

const SAMPLE SAMPLES[] = {
    { "../eeschema/issue9673/issue9673.kicad_pcb",              "6.0" },
    { "issue12964/issue12964.kicad_pcb",                        "6.0" },
    { "../cli/basic_test/basic_test.kicad_pcb",                 "7.0" },
    { "issue14130.kicad_pcb",                                   "7.0" },
    { "issue17971/issue17971.kicad_pcb",                        "8.0" },
    { "issue18045/test_proj.kicad_pcb",                         "8.0" },
    { "../../../demos/complex_hierarchy/complex_hierarchy.kicad_pcb", "9.0" },
    { "../../../demos/ecc83/ecc83-pp.kicad_pcb",                "9.0" },
    { "../../../demos/pic_programmer/pic_programmer.kicad_pcb", "9.0" },
    { "../../../demos/video/video.kicad_pcb",                   "9.0" },
    { "../../../demos/stickhub/StickHub.kicad_pcb",             "10.0 dev" },
    { "../../../demos/cm5_minima/CM5_MINIMA_3.kicad_pcb",       "10.0 dev" },
    { "issue25101.kicad_pcb",                                   "10.0" },
    { "issue24772/fw16_MCIO8i.kicad_pcb",                       "10.0" },
    { "via_stacks.kicad_pcb",                                   "10.99" },
    { "api_kitchen_sink.kicad_pcb",                             "10.99" },
};


std::string readFile( const std::string& aPath )
{
    std::ifstream     in( aPath, std::ios::binary );
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}


/// Equal token for token, except that numbers may differ by up to @a aNm nanometres.
bool sameWithinNanometres( const std::string& aA, const std::string& aB, int aNm )
{
    std::istringstream a( aA ), b( aB );
    std::string        ta, tb;

    while( true )
    {
        const bool gotA = static_cast<bool>( a >> ta );
        const bool gotB = static_cast<bool>( b >> tb );

        if( gotA != gotB )
            return false;

        if( !gotA )
            return true;

        if( ta == tb )
            continue;

        auto number = []( std::string t, double& aOut ) -> bool
        {
            while( !t.empty() && t.back() == ')' )
                t.pop_back();

            char* end = nullptr;
            aOut = std::strtod( t.c_str(), &end );
            return !t.empty() && end && *end == '\0';
        };

        double na = 0, nb = 0;

        if( !number( ta, na ) || !number( tb, nb ) || std::abs( na - nb ) > aNm * 1e-6 + 1e-9 )
            return false;
    }
}


struct COUNTS
{
    size_t footprints = 0, tracks = 0, zones = 0, drawings = 0, nets = 0;

    explicit COUNTS( const BOARD& aBoard ) :
            footprints( aBoard.Footprints().size() ),
            tracks( aBoard.Tracks().size() ),
            zones( aBoard.Zones().size() ),
            drawings( aBoard.Drawings().size() ),
            nets( aBoard.GetNetCount() )
    {}
};

} // namespace


BOOST_AUTO_TEST_SUITE( BoardFormatRoundTrip )


BOOST_AUTO_TEST_CASE( SavedAtTheVersionItWasRead )
{
    const char* keep = std::getenv( "KICAD_ROUNDTRIP_OUT" );

    for( const SAMPLE& sample : SAMPLES )
    {
        const std::string src = KI_TEST::GetPcbnewTestDataDir() + sample.m_path;

        BOOST_TEST_CONTEXT( "KiCad " << sample.m_release << " board " << sample.m_path )
        {
            BOOST_REQUIRE_MESSAGE( wxFileName::FileExists( src ), "missing sample " + src );

            const int stampIn = KICAD_FORMAT::FileFormatVersionStamp( src );

            PCB_IO_KICAD_SEXPR     io;
            std::unique_ptr<BOARD> board( io.LoadBoard( src, nullptr ) );
            BOOST_REQUIRE( board );
            BOOST_CHECK_EQUAL( board->GetFileFormatVersionAtLoad(), stampIn );

            const COUNTS before( *board );

            WX_STRING_REPORTER reporter;
            const wxString     first = wxFileName::CreateTempFileName( wxS( "rt_pcb" ) );
            io.SetReporter( &reporter );
            io.SaveBoard( first, *board );
            io.SetReporter( nullptr );

            const int stampOut = KICAD_FORMAT::FileFormatVersionStamp( first );

            BOOST_TEST_MESSAGE( sample.m_path << ": read " << stampIn << ", saved " << stampOut
                                << ( reporter.HasMessage() ? " -- " + reporter.GetMessages().ToStdString()
                                                           : std::string() ) );

            if( stampIn >= KICAD9_BOARD_VERSION )
            {
                BOOST_CHECK_EQUAL( stampOut, stampIn );
                BOOST_CHECK_MESSAGE( !reporter.HasMessage(), reporter.GetMessages().ToStdString() );
            }
            else
            {
                BOOST_CHECK_GE( stampOut, stampIn );

                if( stampOut != stampIn )
                    BOOST_CHECK( reporter.HasMessage() );
            }

            // The saved file opens again with the same contents...
            PCB_IO_KICAD_SEXPR     io2;
            std::unique_ptr<BOARD> again( io2.LoadBoard( first, nullptr ) );
            BOOST_REQUIRE( again );

            const COUNTS after( *again );
            BOOST_CHECK_EQUAL( after.footprints, before.footprints );
            BOOST_CHECK_EQUAL( after.tracks, before.tracks );
            BOOST_CHECK_EQUAL( after.zones, before.zones );
            BOOST_CHECK_EQUAL( after.drawings, before.drawings );
            BOOST_CHECK_EQUAL( after.nets, before.nets );

            // ...and saving it again changes nothing.
            const wxString second = wxFileName::CreateTempFileName( wxS( "rt_pcb" ) );
            io2.SaveBoard( second, *again );
            // Text on a footprint turned by an odd angle is kept relative to the footprint and
            // rounded to whole nanometres each way, as in stock KiCad, so it may move by a
            // nanometre or two; anything more is a real difference.
            BOOST_CHECK_MESSAGE( sameWithinNanometres( readFile( first.ToStdString() ),
                                                       readFile( second.ToStdString() ), 2 ),
                                 "second save differs from the first" );

            if( keep && *keep )
            {
                std::filesystem::path out( keep );
                std::filesystem::create_directories( out );
                std::filesystem::path name = std::filesystem::path( sample.m_path ).filename();
                std::filesystem::copy_file( first.ToStdString(), out / name,
                                            std::filesystem::copy_options::overwrite_existing );
            }

            wxRemoveFile( first );
            wxRemoveFile( second );
        }
    }
}


// A board stamped by a newer KiCad opens when everything in it is known here.
BOOST_AUTO_TEST_CASE( NewerStampOpens )
{
    const std::string src = KI_TEST::GetPcbnewTestDataDir() + "api_kitchen_sink.kicad_pcb";
    std::string       text = readFile( src );
    const size_t      at = text.find( "(version " );
    BOOST_REQUIRE( at != std::string::npos );

    const size_t end = text.find( ')', at );
    text.replace( at, end - at, "(version " + std::to_string( SEXPR_BOARD_FILE_VERSION + 100000 ) );

    const wxString tmp = wxFileName::CreateTempFileName( wxS( "rt_pcb_newer" ) );
    {
        std::ofstream out( tmp.ToStdString(), std::ios::binary );
        out << text;
    }

    PCB_IO_KICAD_SEXPR     io;
    std::unique_ptr<BOARD> board;
    try
    {
        board = io.LoadBoard( tmp, nullptr );
    }
    catch( const IO_ERROR& e )
    {
        BOOST_ERROR( "a newer stamp did not load: " + e.What().ToStdString() );
    }

    BOOST_CHECK( board && !board->Footprints().empty() );

    wxRemoveFile( tmp );
}


BOOST_AUTO_TEST_SUITE_END()
