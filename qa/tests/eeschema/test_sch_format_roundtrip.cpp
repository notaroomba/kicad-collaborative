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
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Real schematics from every KiCad release since 6.0, opened and saved sheet by sheet the way
 * the editor saves them.
 *
 * A sheet from KiCad 9 or 10 must come back at the version it was read at, so that release keeps
 * opening it.  An older sheet may be raised (the writer has no KiCad 8 grammar), but only with a
 * message saying so.  Either way the saved project must load again with the same contents, and a
 * second save must not change it.  A sheet from a newer KiCad that only uses things this build
 * knows must open.
 *
 * Set KICAD_ROUNDTRIP_OUT to a directory to keep each saved project there, for opening in a
 * stock KiCad of the matching release.
 */

#include <boost/test/unit_test.hpp>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>

#include <wx/filename.h>
#include <wx/stdpaths.h>

#include <qa_utils/wx_utils/unit_test_utils.h>
#include <locale_io.h>
#include <reporter.h>
#include <schematic.h>
#include <sch_screen.h>
#include <sch_sheet.h>
#include <sch_sheet_path.h>
#include <settings/settings_manager.h>
#include <io/kicad/kicad_io_utils.h>
#include <sch_io/kicad_sexpr/sch_io_kicad_sexpr.h>


namespace fs = std::filesystem;

namespace
{

/// The oldest schematic version a stock release still reads that Junction writes back unchanged.
constexpr int KICAD9_SCH_VERSION = 20250114;

struct SAMPLE
{
    const char* m_root;      ///< relative to qa/data/eeschema
    const char* m_release;   ///< the KiCad release that wrote it
    bool        m_folder;    ///< copy every sheet in the root's folder (a hierarchy)
};

const SAMPLE SAMPLES[] = {
    { "netlists/test_multiunit_reannotate_5/test_multiunit_reannotate_5.kicad_sch", "6.0", true },
    { "issue13112.kicad_sch",                                    "6.0",      false },
    { "../cli/basic_test/basic_test.kicad_sch",                  "7.0",      true },
    { "issue16538/issue16538.kicad_sch",                         "7.0",      true },
    { "../../../demos/simulation/q17/Q17ng.kicad_sch",           "8.0",      true },
    { "../pcbnew/unconnected-netnames/unconnected-netnames.kicad_sch", "8.0", true },
    { "../../../demos/complex_hierarchy/complex_hierarchy.kicad_sch", "9.0", true },
    { "../../../demos/video/video.kicad_sch",                    "9.0",      true },
    { "../../../demos/stickhub/StickHub.kicad_sch",              "10.0 dev", true },
    { "../../../demos/cm5_minima/CM5_MINIMA_3.kicad_sch",        "10.0 dev", true },
    { "issue24328/issue24328.kicad_sch",                         "10.0",     true },
    { "../pcbnew/issue24474/issue24474.kicad_sch",               "10.0",     true },
    { "similar_labels.kicad_sch",                                "10.99",    false },
    { "api_kitchen_sink.kicad_sch",                              "10.99",    false },
};


std::string readFile( const fs::path& aPath )
{
    std::ifstream     in( aPath, std::ios::binary );
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}


fs::path freshDir( const std::string& aName )
{
    fs::path dir = fs::path( wxStandardPaths::Get().GetTempDir().ToStdString() )
                   / ( "kicad_sch_roundtrip_" + aName );
    fs::remove_all( dir );
    fs::create_directories( dir );
    return dir;
}


struct LOADED
{
    SETTINGS_MANAGER           m_settings;
    std::unique_ptr<SCHEMATIC> m_schematic;
    SCH_SHEET*                 m_root = nullptr;

    explicit LOADED( const fs::path& aRoot )
    {
        m_settings.LoadProject( "" );
        m_schematic = std::make_unique<SCHEMATIC>( nullptr );
        m_schematic->SetProject( &m_settings.Prj() );
        m_schematic->Reset();

        SCH_SHEET*         defaultSheet = m_schematic->GetTopLevelSheet( 0 );
        SCH_IO_KICAD_SEXPR io;

        m_root = io.LoadSchematicFile( aRoot.string(), m_schematic.get() );
        m_schematic->AddTopLevelSheet( m_root );
        m_schematic->RemoveTopLevelSheet( defaultSheet );
        delete defaultSheet;
    }

    /// file name -> item count, one per screen
    std::map<std::string, size_t> Counts()
    {
        std::map<std::string, size_t> counts;
        SCH_SHEET_LIST                list( m_root );

        for( SCH_SHEET_PATH& path : list )
        {
            SCH_SCREEN* screen = path.LastScreen();
            counts[ fs::path( screen->GetFileName().ToStdString() ).filename().string() ] =
                    screen->Items().size();
        }

        return counts;
    }

    /// Save every screen once, like File > Save.  Returns what the writer reported.
    wxString SaveAll()
    {
        WX_STRING_REPORTER    reporter;
        std::set<SCH_SCREEN*> done;
        SCH_SHEET_LIST        list( m_root );

        for( SCH_SHEET_PATH& path : list )
        {
            SCH_SCREEN* screen = path.LastScreen();

            if( !done.insert( screen ).second )
                continue;

            SCH_IO_KICAD_SEXPR io;
            io.SetReporter( &reporter );
            io.SaveSchematicFile( screen->GetFileName(), path.Last(), m_schematic.get() );
        }

        return reporter.GetMessages();
    }
};


std::map<std::string, std::string> snapshot( const fs::path& aDir )
{
    std::map<std::string, std::string> files;

    for( const fs::directory_entry& entry : fs::directory_iterator( aDir ) )
    {
        if( entry.path().extension() == ".kicad_sch" )
            files[ entry.path().filename().string() ] = readFile( entry.path() );
    }

    return files;
}

} // namespace


BOOST_AUTO_TEST_SUITE( SchematicFormatRoundTrip )


BOOST_AUTO_TEST_CASE( SavedAtTheVersionItWasRead )
{
    LOCALE_IO   dummy;
    const char* keep = std::getenv( "KICAD_ROUNDTRIP_OUT" );

    for( const SAMPLE& sample : SAMPLES )
    {
        const fs::path src = fs::path( KI_TEST::GetEeschemaTestDataDir() ) / sample.m_root;

        BOOST_TEST_CONTEXT( "KiCad " << sample.m_release << " schematic " << sample.m_root )
        {
            BOOST_REQUIRE_MESSAGE( fs::exists( src ), "missing sample " + src.string() );

            const fs::path dir = freshDir( src.stem().string() );

            if( sample.m_folder )
            {
                for( const fs::directory_entry& entry : fs::directory_iterator( src.parent_path() ) )
                {
                    const std::string ext = entry.path().extension().string();

                    if( ext == ".kicad_sch" || ext == ".kicad_pro" )
                        fs::copy_file( entry.path(), dir / entry.path().filename() );
                }
            }
            else
            {
                fs::copy_file( src, dir / src.filename() );
            }

            std::map<std::string, int> stampsIn;

            for( const auto& [name, text] : snapshot( dir ) )
                stampsIn[name] = KICAD_FORMAT::FileFormatVersionStamp( ( dir / name ).string() );

            const fs::path root = dir / src.filename();

            std::map<std::string, size_t> before;
            wxString                      messages;

            {
                LOADED loaded( root );
                BOOST_REQUIRE( loaded.m_root );
                before = loaded.Counts();
                messages = loaded.SaveAll();
            }

            const std::map<std::string, std::string> first = snapshot( dir );

            for( const auto& [name, text] : first )
            {
                if( !before.count( name ) )
                    continue;   // a sheet file in the folder that this hierarchy does not use

                const int in = stampsIn[name];
                const int out = KICAD_FORMAT::FileFormatVersionStamp( ( dir / name ).string() );

                BOOST_TEST_MESSAGE( sample.m_root << " / " << name << ": read " << in
                                    << ", saved " << out );

                if( in >= KICAD9_SCH_VERSION )
                {
                    BOOST_CHECK_MESSAGE( out == in, name + ": read " + std::to_string( in )
                                                    + ", saved " + std::to_string( out ) );
                }
                else
                {
                    BOOST_CHECK_GE( out, in );

                    if( out != in )
                        BOOST_CHECK_MESSAGE( !messages.IsEmpty(), name + " raised silently" );
                }
            }

            if( stampsIn[ src.filename().string() ] >= KICAD9_SCH_VERSION )
                BOOST_CHECK_MESSAGE( messages.IsEmpty(), messages.ToStdString() );

            // The saved project opens again with the same contents, and a second save changes
            // nothing.
            {
                LOADED again( root );
                BOOST_REQUIRE( again.m_root );
                BOOST_CHECK( again.Counts() == before );
                again.SaveAll();
            }

            const std::map<std::string, std::string> second = snapshot( dir );

            for( const auto& [name, text] : first )
                BOOST_CHECK_MESSAGE( second.at( name ) == text, name + ": second save differs" );

            if( keep && *keep )
            {
                const fs::path out = fs::path( keep ) / src.stem();
                fs::remove_all( out );
                fs::create_directories( out );
                fs::copy( dir, out, fs::copy_options::recursive );
            }

            fs::remove_all( dir );
        }
    }
}


// A sheet stamped by a newer KiCad opens when everything in it is known here.
BOOST_AUTO_TEST_CASE( NewerStampOpens )
{
    LOCALE_IO      dummy;
    const fs::path src = fs::path( KI_TEST::GetEeschemaTestDataDir() ) / "api_kitchen_sink.kicad_sch";
    std::string    text = readFile( src );
    const size_t   at = text.find( "(version " );
    BOOST_REQUIRE( at != std::string::npos );

    const size_t end = text.find( ')', at );
    text.replace( at, end - at,
                  "(version " + std::to_string( SEXPR_SCHEMATIC_FILE_VERSION + 100000 ) );

    const fs::path dir = freshDir( "newer" );
    {
        std::ofstream out( dir / "newer.kicad_sch", std::ios::binary );
        out << text;
    }

    std::unique_ptr<LOADED> loaded;
    BOOST_CHECK_NO_THROW( loaded = std::make_unique<LOADED>( dir / "newer.kicad_sch" ) );
    BOOST_CHECK( loaded && loaded->m_root && !loaded->m_root->GetScreen()->Items().empty() );

    loaded.reset();
    fs::remove_all( dir );
}


BOOST_AUTO_TEST_SUITE_END()
