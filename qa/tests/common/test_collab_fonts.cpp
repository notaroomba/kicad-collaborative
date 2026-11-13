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

#include <collab/collab_fonts.h>
#include <nlohmann/json.hpp>

BOOST_AUTO_TEST_SUITE( CollabFonts )


BOOST_AUTO_TEST_CASE( GoogleFamilyLookup )
{
    BOOST_CHECK_GT( COLLAB_FONTS::GoogleFamilies().GetCount(), 1500u );

    const COLLAB_FONTS::GOOGLE_FAMILY* roboto = COLLAB_FONTS::FindGoogleFamily( wxS( "roboto " ) );

    BOOST_REQUIRE( roboto );
    BOOST_CHECK_EQUAL( std::string( roboto->family ), "Roboto" );
    BOOST_CHECK_EQUAL( roboto->regular, 400 );
    BOOST_CHECK_EQUAL( roboto->bold, 700 );
    BOOST_CHECK_EQUAL( roboto->italics, 3 );

    BOOST_CHECK( !COLLAB_FONTS::FindGoogleFamily( wxS( "Not A Font Anybody Made" ) ) );
    BOOST_CHECK( !COLLAB_FONTS::FindGoogleFamily( wxEmptyString ) );
}


BOOST_AUTO_TEST_CASE( FacesOfAnOperation )
{
    nlohmann::json op = {
        { "type", "op" },
        { "changes",
          { { { "id", "a" },
              { "text", "(text \"hello\" (at 1 2 0) (effects (font (face \"Pacifico\") (size 1.27 1.27))))" } },
            { { "id", "b" },
              { "text", "(label \"x\" (effects (font (face \"My \\\"Own\\\" Font\") (size 1 1)) (justify left)))" } },
            { { "id", "c" }, { "text", "(wire (pts (xy 0 0) (xy 1 1)))" } },
            { { "id", "d" },
              { "nested", { "(property \"Value\" \"1k\" (effects (font (face \"Pacifico\"))))", 7, nullptr } } } } }
    };

    std::set<wxString> faces = COLLAB_FONTS::FacesIn( op );

    BOOST_CHECK_EQUAL( faces.size(), 2u );
    BOOST_CHECK( faces.count( wxS( "Pacifico" ) ) );
    BOOST_CHECK( faces.count( wxS( "My \"Own\" Font" ) ) );

    // Cut off in the middle of a name: nothing to go on.
    std::set<wxString> none;
    COLLAB_FONTS::FacesInText( "(font (face \"Pacif", none );
    COLLAB_FONTS::FacesInText( "(font (face \"\"))", none );
    BOOST_CHECK( none.empty() );
}


BOOST_AUTO_TEST_CASE( FileNames )
{
    BOOST_CHECK_EQUAL( COLLAB_FONTS::FileNameFor( wxS( "Open Sans" ), false, false, false ),
                       wxString( wxS( "Open Sans-Regular.ttf" ) ) );
    BOOST_CHECK_EQUAL( COLLAB_FONTS::FileNameFor( wxS( "Open Sans" ), true, true, true ),
                       wxString( wxS( "Open Sans-BoldItalic.otf" ) ) );
    BOOST_CHECK_EQUAL( COLLAB_FONTS::FileNameFor( wxS( "../../etc/passwd" ), false, true, false ),
                       wxString( wxS( "______etc_passwd-Italic.ttf" ) ) );
    BOOST_CHECK_EQUAL( COLLAB_FONTS::FileNameFor( wxS( "  " ), true, false, false ),
                       wxString( wxS( "font-Bold.ttf" ) ) );
}


BOOST_AUTO_TEST_SUITE_END()
