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
