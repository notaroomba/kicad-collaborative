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

#pragma once

#include <set>
#include <vector>

#include <kicommon.h>
#include <nlohmann/json.hpp>
#include <wx/arrstr.h>
#include <wx/string.h>

/**
 * Fonts that are not installed on this computer but can be had: every Google Font, and the
 * fonts kept with an online project.
 *
 * Text names its font (`(font (face "…"))`).  A font that is missing is substituted, and the
 * text moves.  So:
 *
 *  - a Google Font is downloaded the first time it is chosen or met in a design;
 *  - in an online project, a font the design uses that only exists on this computer is
 *    uploaded to the project (when the font's own embedding permission allows it), and a font
 *    this computer lacks is downloaded from the project.
 *
 * Downloaded files are kept in FONTCONFIG::DownloadedFontsDir() and are available from then on.
 */
namespace COLLAB_FONTS
{

/// A family of the Google Fonts list (common/font/google_fonts_list.inc).
struct GOOGLE_FAMILY
{
    const char* family;
    int         regular;    ///< the weight that stands for regular
    int         bold;       ///< the weight that stands for bold, 0 when there is none
    int         italics;    ///< bit 0: regular has an italic, bit 1: bold has one
};

/// The Google Fonts families, sorted.
KICOMMON_API const wxArrayString& GoogleFamilies();

/// The entry of a family, whatever the case of the name; nullptr when it is not a Google Font.
KICOMMON_API const GOOGLE_FAMILY* FindGoogleFamily( const wxString& aFamily );

/// The outline fonts named anywhere in a message or document: every `(face "…")` in every
/// string of @a aPayload.
KICOMMON_API std::set<wxString> FacesIn( const nlohmann::json& aPayload );

/// The same, in one piece of text.
KICOMMON_API void FacesInText( const std::string& aText, std::set<wxString>& aFaces );

/// The name a downloaded font file is kept under: "Open Sans-BoldItalic.ttf".
KICOMMON_API wxString FileNameFor( const wxString& aFamily, bool aBold, bool aItalic, bool aOpenType );

/**
 * Fetch a family now, on the calling thread: from the online project that is open, else from
 * Google Fonts.  Used when a font is chosen in a dialog, so that the text is drawn in it at once.
 *
 * @return true when the family can be drawn afterwards.
 */
KICOMMON_API bool FetchNow( const wxString& aFamily );

/**
 * Have fonts that are found missing fetched in the background (FONTCONFIG's missing-font
 * handler).  Only in a program with windows: the command line tools and the tests draw with
 * the fonts they have.
 */
KICOMMON_API void Install();

/**
 * The fonts a message of the live session names, sent or received: the ones this computer
 * lacks are fetched from the project, the ones only this computer has are uploaded to it.
 * Main thread.
 */
KICOMMON_API void NoteFaces( const nlohmann::json& aPayload );

/**
 * The same for a design file as it is opened in a live session: a project made before
 * anybody shared its fonts gets them from the first collaborator who has them.
 * Main thread.
 */
KICOMMON_API void NoteFacesInFile( const wxString& aPath );

/// Stop the background work (before curl is shut down).
KICOMMON_API void Shutdown();

} // namespace COLLAB_FONTS
