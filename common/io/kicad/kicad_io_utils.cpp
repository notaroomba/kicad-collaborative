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

#include "io/kicad/kicad_io_utils.h"

// For some reason wxWidgets is built with wxUSE_BASE64 unset so expose the wxWidgets
// base64 code.
#define wxUSE_BASE64 1
#include <wx/base64.h>
#include <wx/ffile.h>

#include <fmt/format.h>

#include <string_view>
#include <unordered_map>

#include <eda_item.h>
#include <kiid.h>
#include <richio.h>
#include <string_utils.h>

namespace KICAD_FORMAT {

void FormatBool( OUTPUTFORMATTER* aOut, const wxString& aKey, bool aValue )
{
    aOut->Print( "(%ls %s)", aKey.wc_str(), aValue ? "yes" : "no" );
}

void FormatOptBool( OUTPUTFORMATTER* aOut, const wxString& aKey, std::optional<bool> aValue )
{
    if( aValue.has_value() )
        FormatBool( aOut, aKey, aValue.value() );
    else
        aOut->Print( "(%ls none)", aKey.wc_str() );
}


void FormatUuid( OUTPUTFORMATTER* aOut, const KIID& aUuid )
{
    aOut->Print( "(uuid %s)", aOut->Quotew( aUuid.AsString() ).c_str() );
}


void FormatCustomProperties( OUTPUTFORMATTER* aOut, const EDA_ITEM& aItem )
{
    if( !aItem.HasCustomProperties() )
        return;

    for( const auto& [key, value] : aItem.GetCustomProperties() )
        aOut->Print( "(custom_property %s %s)", aOut->Quotew( key ).c_str(), aOut->Quotew( value ).c_str() );
}


void FormatStreamData( OUTPUTFORMATTER& aOut, const wxStreamBuffer& aStream )
{
    aOut.Print( "(data" );

    const wxString out = wxBase64Encode( aStream.GetBufferStart(), aStream.GetBufferSize() );

    // Apparently the MIME standard character width for base64 encoding is 76 (unconfirmed)
    // so use it in a vein attempt to be standard like.
    static constexpr unsigned MIME_BASE64_LENGTH = 76;

    size_t first = 0;

    while( first < out.Length() )
    {
        aOut.Print( "\n\"%s\"", TO_UTF8( out( first, MIME_BASE64_LENGTH ) ) );
        first += MIME_BASE64_LENGTH;
    }

    aOut.Print( ")" ); // Closes data token.
}


/*
 * Formatting rules:
 * - All extra (non-indentation) whitespace is trimmed
 * - Indentation is one tab
 * - Starting a new list (open paren) starts a new line with one deeper indentation
 * - Lists with no inner lists go on a single line
 * - End of multi-line lists (close paren) goes on a single line at same indentation as its start
 *
 * For example:
 * (first
 *  (second
 *   (third list)
 *   (another list)
 *  )
 *  (fifth)
 *  (sixth thing with lots of tokens
 *   (and a sub list)
 *  )
 * )
 */
void Prettify( std::string& aSource, FORMAT_MODE aMode )
{
    // Configuration
    const char quoteChar = '"';
    const char indentChar = '\t';
    const int  indentSize = 1;

    // In order to visually compress PCB files, it is helpful to special-case long lists of (xy ...)
    // lists, which we allow to exist on a single line until we reach column 99.
    const int  xySpecialCaseColumnLimit = 99;

    // If whitespace occurs inside a list after this threshold, it will be converted into a newline
    // and the indentation will be increased.  This is mainly used for image and group objects,
    // which contain potentially long sets of string tokens within a single list.
    const int  consecutiveTokenWrapThreshold = 72;

    const bool textSpecialCase = aMode == FORMAT_MODE::COMPACT_TEXT_PROPERTIES;
    const bool libSpecialCase  = aMode == FORMAT_MODE::LIBRARY_TABLE;

    std::string formatted;
    formatted.reserve( aSource.length() );

    auto cursor = aSource.begin();
    auto seek = cursor;

    int  listDepth = 0;
    int  libDepth = 0;
    char lastNonWhitespace = 0;
    bool inQuote = false;
    bool hasInsertedSpace = false;
    bool inMultiLineList = false;
    bool inXY = false;
    bool inShortForm = false;
    bool inLibRow = false;
    int  shortFormDepth = 0;
    int  column = 0;
    int  backslashCount = 0;    // Count of successive backslash read since any other char

    auto isWhitespace = []( const char aChar )
            {
                return ( aChar == ' ' || aChar == '\t' || aChar == '\n' || aChar == '\r' );
            };

    auto nextNonWhitespace =
            [&]( std::string::iterator aIt )
            {
                seek = aIt;

                while( seek != aSource.end() && isWhitespace( *seek ) )
                    seek++;

                if( seek == aSource.end() )
                    return (char)0;

                return *seek;
            };

    auto isXY =
            [&]( std::string::iterator aIt )
            {
                seek = aIt;

                if( ++seek == aSource.end() || *seek != 'x' )
                    return false;

                if( ++seek == aSource.end() || *seek != 'y' )
                    return false;

                if( ++seek == aSource.end() || *seek != ' ' )
                    return false;

                return true;
            };

    auto isShortForm =
            [&]( std::string::iterator aIt )
            {
                seek = aIt;
                std::string token;

                while( ++seek != aSource.end() && isalpha( *seek ) )
                    token += *seek;

                return token == "font" || token == "stroke" || token == "fill" || token == "teardrop"
                        || token == "offset" || token == "rotate" || token == "scale";
            };

    auto isLib =
            [&]( std::string::iterator aIt )
            {
                seek = aIt;
                std::string token;

                while( ++seek != aSource.end() && isalpha( *seek ) )
                    token += *seek;

                return token == "lib";
            };

    while( cursor != aSource.end() )
    {
        char next = nextNonWhitespace( cursor );

        if( isWhitespace( *cursor ) && !inQuote )
        {
            if( !hasInsertedSpace           // Only permit one space between chars
                && listDepth > 0            // Do not permit spaces in outer list
                && lastNonWhitespace != '(' // Remove extra space after start of list
                && next != ')'              // Remove extra space before end of list
                && next != '(' )            // Remove extra space before newline
            {
                if( inXY || column < consecutiveTokenWrapThreshold )
                {
                    // Note that we only insert spaces here, no matter what kind of whitespace is
                    // in the input.  Newlines will be inserted as needed by the logic below.
                    formatted.push_back( ' ' );
                    column++;
                }
                else if( inShortForm || inLibRow )
                {
                    formatted.push_back( ' ' );
                }
                else
                {
                    formatted += fmt::format( "\n{}",
                                              std::string( listDepth * indentSize, indentChar ) );
                    column = listDepth * indentSize;
                    inMultiLineList = true;
                }

                hasInsertedSpace = true;
            }
        }
        else
        {
            hasInsertedSpace = false;

            if( *cursor == '(' && !inQuote )
            {
                bool currentIsXY = isXY( cursor );
                bool currentIsShortForm = textSpecialCase && isShortForm( cursor );
                bool currentIsLib = libSpecialCase && isLib( cursor );

                if( formatted.empty() )
                {
                    formatted.push_back( '(' );
                    column++;
                }
                else if( inXY && currentIsXY && column < xySpecialCaseColumnLimit )
                {
                    // List-of-points special case
                    formatted += " (";
                    column += 2;
                }
                else if( inShortForm || inLibRow )
                {
                    formatted += " (";
                    column += 2;
                }
                else
                {
                    formatted += fmt::format( "\n{}(",
                                              std::string( listDepth * indentSize, indentChar ) );
                    column = listDepth * indentSize + 1;
                }

                inXY = currentIsXY;

                if( currentIsShortForm )
                {
                    inShortForm = true;
                    shortFormDepth = listDepth;
                }
                else if( currentIsLib )
                {
                    inLibRow = true;
                    libDepth = listDepth;
                }

                listDepth++;
            }
            else if( *cursor == ')' && !inQuote )
            {
                if( listDepth > 0 )
                    listDepth--;

                if( inShortForm )
                {
                    formatted.push_back( ')' );
                    column++;
                }
                else if( inLibRow && listDepth == libDepth )
                {
                    formatted.push_back( ')' );
                    inLibRow = false;
                }
                else if( lastNonWhitespace == ')' || inMultiLineList )
                {
                    formatted += fmt::format( "\n{})",
                                              std::string( listDepth * indentSize, indentChar ) );
                    column = listDepth * indentSize + 1;
                    inMultiLineList = false;
                }
                else
                {
                    formatted.push_back( ')' );
                    column++;
                }

                if( shortFormDepth == listDepth )
                {
                    inShortForm = false;
                    shortFormDepth = 0;
                }
            }
            else
            {
                // The output formatter escapes double-quotes (like \")
                // But a corner case is a sequence like \\"
                // therefore a '\' is attached to a '"' if a odd number of '\' is detected
                if( *cursor == '\\' )
                    backslashCount++;
                else if( *cursor == quoteChar && ( backslashCount & 1 ) == 0 )
                    inQuote = !inQuote;

                if( *cursor != '\\' )
                    backslashCount = 0;

                formatted.push_back( *cursor );
                column++;
            }

            lastNonWhitespace = *cursor;
        }

        ++cursor;
    }

    // newline required at end of line / file for POSIX compliance. Keeps git diffs clean.
    formatted += '\n';

    aSource = std::move( formatted );
}

/*
 * Minimum-file-format-version detection.
 *
 * The tables below map a token to the file format version that introduced it, derived
 * mechanically from the keyword files (eeschema/schematic.keywords, common/pcb.keywords):
 * for every keyword, the version that was active in the corresponding version ledger when
 * that keyword was first added to the lexer.  A token that the older lexer did not know
 * cannot appear in an older file, so writing it under an older stamp produces a file that
 * an older KiCad rejects.
 *
 * Entries marked "corpus-corrected" were lowered because a KiCad-written test file that
 * declares an older (and valid) version already contains the token; the mechanical
 * derivation had attributed it one bump too late.
 *
 * Tokens introduced with the first ledger entry of each format are omitted: they impose no
 * requirement.  Value-only words (yes/no/none) never appear in token position and are
 * omitted too.
 */

namespace {

struct TOKEN_VERSION
{
    const char* m_token;
    int         m_version;
};

struct VERSION_FEATURE
{
    int         m_version;
    const char* m_feature;
};

static const TOKEN_VERSION SCHEMATIC_TOKEN_VERSIONS[] = {
    // 20200512  Add support for exclude from BOM.
    { "paper", 20200512 },
    // 20200602  Add support for exclude from board.
    { "in_bom", 20200602 },
    // 20200608  Add support for bus and junction properties.
    { "on_board", 20200608 },
    // 20200618  Disallow duplicate field ids.
    { "diameter", 20200618 },
    // 20200828  Add footprint to symbol_instances.
    { "default", 20200828 },
    { "footprint", 20200828 },
    { "iref", 20200828 },
    { "value", 20200828 },
    // 20201015  Add sheet instance properties.
    { "free", 20201015 },
    { "sheet_instances", 20201015 },
    // 20210126  Fix bug with writing pin uuids.
    { "field", 20210126 },
    { "fields_autoplaced", 20210126 },
    // 20220103  Label fields
    { "diamond", 20220103 },
    { "netclass_flag", 20220103 },
    // 20220104  Fonts
    { "face", 20220104 },
    { "line_spacing", 20220104 },
    // 20220124  netclass_flag -> directive_label
    { "directive_label", 20220124 },
    // 20220126  Text boxes
    { "private", 20220126 },
    { "text_box", 20220126 },
    // 20220404  Default schematic symbol instance data.
    { "default_instance", 20220404 },
    // 20220822  Hyperlinks in text objects
    { "href", 20220822 },
    { "show_name", 20220822 },
    // 20220904  Do not autoplace field option
    { "do_not_autoplace", 20220904 },
    { "unit_name", 20220904 },
    // 20220914  Add support for DNP
    { "dnp", 20220914 },
    // 20220919  
    { "project", 20220919 },
    // 20230409  Add exclude_from_sim markup
    { "exclude_from_sim", 20230409 },
    { "from", 20230409 },
    // 20240101  Tables.
    { "border", 20240101 },
    { "cells", 20240101 },
    { "cols", 20240101 },
    { "column_count", 20240101 },
    { "column_widths", 20240101 },
    { "external", 20240101 },
    { "header", 20240101 },
    { "margins", 20240101 },
    { "row_heights", 20240101 },
    { "rows", 20240101 },
    { "separators", 20240101 },
    { "span", 20240101 },
    { "table", 20240101 },
    { "table_cell", 20240101 },
    // 20240417  Rule areas
    { "rule_area", 20240417 },
    // 20240620  Embedded Files
    { "checksum", 20240620 },
    { "embedded_files", 20240620 },
    { "embedded_fonts", 20240620 },
    { "file", 20240620 },
    // 20250222  Hatched fills for shapes
    { "cross_hatch", 20250222 },
    { "hatch", 20250222 },
    { "reverse_hatch", 20250222 },
    // 20250227  Support for local power symbols
    { "local", 20250227 },
    // 20250318  ~ no longer means empty text
    { "duplicate_pin_numbers_are_jumpers", 20250227 },   // corpus-corrected
    { "group", 20250318 },
    { "jumper_pin_groups", 20250227 },   // corpus-corrected
    // 20250827  Custom body styles
    { "body_style", 20250827 },
    { "body_styles", 20250827 },
    { "demorgan", 20250827 },
    // 20250922  Schematic variants.
    { "variant", 20250922 },
    // 20260101  PCB variants
    { "in_pos_files", 20251028 },   // corpus-corrected
    // 20260326  Locking properties
    { "locked", 20260326 },
    // 20260508  Native ellipse primitive
    { "ellipse", 20260508 },
    { "ellipse_arc", 20260508 },
    { "end_angle", 20260508 },
    { "major_radius", 20260508 },
    { "minor_radius", 20260508 },
    { "rotation_angle", 20260508 },
    { "start_angle", 20260508 },
    // 20260512  Net chains
    { "net_chain", 20260512 },
    { "net_class", 20260512 },
    { "nets", 20260512 },
    { "passthrough", 20260512 },
    // 20260629  Pin-to-pad maps (issue #2282)
    { "associated_footprints", 20260629 },
    { "delegate", 20260629 },
    { "edit", 20260629 },
    { "identity", 20260629 },
    { "library_default", 20260629 },
    { "mode", 20260629 },
    { "named_map", 20260629 },
    { "pin_map", 20260629 },
    { "pin_map_override", 20260629 },
    { "pin_maps", 20260629 },
    // 20260722  Dedicated variant symbol_override token
    { "symbol_override", 20260722 },
    // 20260818  Line ending shapes
    { "arrow", 20260818 },
    { "arrow_open", 20260818 },
    { "end_shape", 20260818 },
    { "square", 20260818 },
    { "start_shape", 20260818 },
    // 20260830  Custom user properties
    { "custom_property", 20260830 },
};

static const TOKEN_VERSION SYMBOL_LIB_TOKEN_VERSIONS[] = {
    // The symbol library format shares eeschema/schematic.keywords with the schematic format
    // but has its own version ledger, so the same token carries a different requirement here.
    // Only tokens the symbol library writer can actually emit are listed.
    // 20220102  Fonts
    { "face", 20220102 },
    { "line_spacing", 20220102 },
    // 20220126  Text boxes
    { "private", 20220126 },
    { "text_box", 20220126 },
    // 20220331  Text colors
    { "do_not_autoplace", 20220331 },
    { "href", 20220331 },
    { "show_name", 20220331 },
    // 20220914  Symbol unit display names
    { "exclude_from_sim", 20220914 },
    { "unit_name", 20220914 },
    // 20231120  generator_version; V8 cleanups
    { "generator_version", 20231120 },
    // 20240529  Embedded Files ("embedded_fonts" is corpus-corrected: a KiCad-written 20231120
    // library already contains it)
    { "checksum", 20240529 },
    { "embedded_files", 20240529 },
    { "embedded_fonts", 20231120 },   // corpus-corrected
    { "file", 20240529 },
    // 20241209  Private flags for SCH_FIELDs
    { "cross_hatch", 20241209 },
    { "hatch", 20241209 },
    { "reverse_hatch", 20241209 },
    // 20250324  Jumper pin groups
    { "body_style", 20250324 },
    { "body_styles", 20250324 },
    { "demorgan", 20250324 },
    { "duplicate_pin_numbers_are_jumpers", 20250324 },
    { "group", 20250324 },
    { "jumper_pin_groups", 20250324 },
    // 20251024  Updated properties formatting (do_not_autoplace, show_name)
    { "in_pos_files", 20251024 },
    { "locked", 20251024 },
    // 20260508  Native ellipse primitive
    { "ellipse", 20260508 },
    { "ellipse_arc", 20260508 },
    { "end_angle", 20260508 },
    { "major_radius", 20260508 },
    { "minor_radius", 20260508 },
    { "rotation_angle", 20260508 },
    { "start_angle", 20260508 },
    // 20260629  Pin-to-pad maps (issue #2282)
    { "associated_footprints", 20260629 },
    { "delegate", 20260629 },
    { "edit", 20260629 },
    { "entry", 20260629 },
    { "identity", 20260629 },
    { "library_default", 20260629 },
    { "map", 20260629 },
    { "mode", 20260629 },
    { "named_map", 20260629 },
    { "pin_map", 20260629 },
    { "pin_map_override", 20260629 },
    { "pin_maps", 20260629 },
    // 20260710  Line ending shapes
    { "arrow", 20260710 },
    { "arrow_open", 20260710 },
    { "end_shape", 20260710 },
    { "square", 20260710 },
    { "start_shape", 20260710 },
    // 20260830  Custom user properties
    { "custom_property", 20260830 },
};

static const TOKEN_VERSION BOARD_TOKEN_VERSIONS[] = {
    // 20240202  Tables
    { "cells", 20240202 },
    { "cols", 20240202 },
    { "column_count", 20240202 },
    { "column_widths", 20240202 },
    { "external", 20240202 },
    { "header", 20240202 },
    { "margins", 20240202 },
    { "row_heights", 20240202 },
    { "rows", 20240202 },
    { "separators", 20240202 },
    { "span", 20240202 },
    { "table", 20240202 },
    { "table_cell", 20240202 },
    // 20240225  Rationalization of solder_paste_margin (pad_prop_mechanical is a value, see
    // BOARD_VALUE_ATOM_VERSIONS)
    // 20240609  Add 'tenting' keyword
    { "back", 20240609 },
    { "front", 20240609 },
    { "tenting", 20240609 },
    // 20240706  Embedded Files
    { "embedded_files", 20240706 },
    { "embedded_fonts", 20240706 },
    { "placement", 20240706 },
    // 20240928  Component classes
    { "component_class", 20240928 },
    { "component_classes", 20240928 },
    // 20240929  Complex padstacks
    { "front_inner_back", 20240929 },
    { "padstack", 20240929 },
    { "shape", 20240929 },
    // 20241010  Graphic shapes can have soldermask layer and margin
    { "creepage", 20241010 },
    // 20241030  Dimension arrow directions, suppress_zeroes normalization
    { "arrow_direction", 20241030 },
    { "inward", 20241030 },
    { "outward", 20241030 },
    // 20241228  Convert teardrop curve points to bool
    { "curved_edges", 20241228 },
    // 20250222  Hatching for PCB shapes
    { "cross_hatch", 20250222 },
    { "reverse_hatch", 20250222 },
    // 20250228  ipc-4761 via protection features
    { "capping", 20250228 },
    { "covering", 20250228 },
    { "filling", 20250228 },
    { "plugging", 20250228 },
    // 20250302  Zone Hatching Offsets
    { "hatch_position", 20241229 },   // corpus-corrected
    { "zone_defaults", 20250302 },
    // 20250324  Jumper pads
    { "duplicate_pad_numbers_are_jumpers", 20250309 },   // corpus-corrected
    { "jumper_pad_groups", 20250309 },   // corpus-corrected
    { "num", 20250324 },
    // 20250401  Time domain length tuning
    { "die_delay", 20250401 },
    // 20250513  Groups can have design block lib_id
    { "lib_id", 20250513 },
    // 20250801  (island) -> (island yes/no) (pad_prop_pressfit is a value, see
    // BOARD_VALUE_ATOM_VERSIONS)
    { "start_end_only", 20250801 },
    // 20250909  footprint unit metadata (units/pins)
    { "pins", 20250909 },
    // 20250914  Add support for PCB_BARCODE objects
    { "barcode", 20250914 },
    { "ecc_level", 20250914 },
    { "text_height", 20250914 },
    // 20251101  Backdrill and tertiary drill support
    { "back_post_machining", 20251101 },
    { "backdrill", 20251101 },
    { "counterbore", 20251101 },
    { "countersink", 20251101 },
    { "depth", 20251101 },
    { "front_post_machining", 20251101 },
    { "post_machining", 20251101 },
    { "tertiary_drill", 20251101 },
    // 20260101  PCB variants with per-footprint overrides
    { "description", 20260101 },
    { "field", 20260101 },
    { "variant", 20260101 },
    { "variants", 20260101 },
    // 20260410  Extruded 3D body
    { "body_pcb_gap", 20260410 },
    { "extruded", 20260410 },
    { "overall_height", 20260410 },
    // 20260508  Native ellipse primitive
    { "end_angle", 20260508 },
    { "fp_ellipse", 20260508 },
    { "fp_ellipse_arc", 20260508 },
    { "gr_ellipse", 20260508 },
    { "gr_ellipse_arc", 20260508 },
    { "major_radius", 20260508 },
    { "minor_radius", 20260508 },
    { "rotation_angle", 20260508 },
    { "start_angle", 20260508 },
    // 20260511  Dielectric frequency-dependent models in board stackup
    { "constant", 20260511 },
    { "dielectric_model", 20260511 },
    { "djordjevic_sarkar", 20260511 },
    { "spec_frequency", 20260511 },
    // 20260512  Net chains
    { "net_chain", 20260512 },
    { "net_chains", 20260512 },
    { "terminal_pad", 20260512 },
    // 20260513  Copper thieving zone fill mode
    { "dots", 20260513 },
    { "square", 20260513 },
    { "squares", 20260513 },
    { "stagger", 20260513 },
    { "thieving", 20260513 },
    // 20260521  Pad simulation electrical types
    { "sim_electrical_type", 20260521 },
    // 20260616  Footprint affine transform: lib-frame storage and (transform) block
    { "transform", 20260616 },
    { "translate", 20260616 },
    // 20260624  Geometric constraints (#2329)
    { "driving", 20260624 },
    // 20260728  Grid items
    { "affects", 20260728 },
    { "cursor", 20260728 },
    { "extent", 20260728 },
    { "grid_item", 20260728 },
    { "polar", 20260728 },
    { "routing", 20260728 },
    { "tick_interval", 20260728 },
    // 20260816  Via stitching and guarding
    { "ij", 20260816 },
    { "template", 20260816 },
    { "templates", 20260816 },
    // 20260818  Line ending shapes
    { "arrow_open", 20260818 },
    { "background", 20260818 },
    { "end_shape", 20260818 },
    { "start_shape", 20260818 },
    // 20260828  Exclude-from-simulation footprint attribute (a value of (attr), see
    // BOARD_VALUE_ATOM_VERSIONS)
    // 20260831  Custom user properties
    { "custom_property", 20260831 },
};

/*
 * Words that carry a version requirement when they appear in *value* position rather than as a
 * token.  `(attr smd exclude_from_sim)` and `(property pad_prop_pressfit)` are bare atoms, so the
 * token-position scan above cannot see them, yet an older lexer rejects them exactly as it would
 * an unknown token.  They are matched only outside token position so that a word which is a
 * token elsewhere in the grammar cannot cross-fire.
 */
static const TOKEN_VERSION BOARD_VALUE_ATOM_VERSIONS[] = {
    // 20240225  Rationalization of solder_paste_margin: (property pad_prop_mechanical)
    { "pad_prop_mechanical", 20240225 },
    // 20250801  (island) -> (island yes/no): (property pad_prop_pressfit)
    { "pad_prop_pressfit", 20250801 },
    // 20260828  Exclude-from-simulation footprint attribute: (attr ... exclude_from_sim)
    { "exclude_from_sim", 20260828 },
};

static const TOKEN_VERSION SCHEMATIC_VALUE_ATOM_VERSIONS[] = {
    // 20250227  Support for local power symbols: (power local) / (power global)
    { "global", 20250227 },
    { "local", 20250227 },
};

static const TOKEN_VERSION SYMBOL_LIB_VALUE_ATOM_VERSIONS[] = {
    // 20241209  (power local) / (power global)
    { "global", 20241209 },
    { "local", 20241209 },
    // 20250324  (body_styles demorgan)
    { "demorgan", 20250324 },
};

static const VERSION_FEATURE SCHEMATIC_VERSION_FEATURES[] = {
    { 20200512, "Add support for exclude from BOM." },
    { 20200602, "Add support for exclude from board." },
    { 20200608, "Add support for bus and junction properties." },
    { 20200618, "Disallow duplicate field ids." },
    { 20200828, "Add footprint to symbol_instances." },
    { 20201015, "Add sheet instance properties." },
    { 20210126, "Fix bug with writing pin uuids." },
    { 20220103, "Label fields" },
    { 20220104, "Fonts" },
    { 20220124, "netclass_flag -> directive_label" },
    { 20220126, "Text boxes" },
    { 20220404, "Default schematic symbol instance data." },
    { 20220822, "Hyperlinks in text objects" },
    { 20220904, "Do not autoplace field option" },
    { 20220914, "Add support for DNP" },
    { 20220919, "" },
    { 20230409, "Add exclude_from_sim markup" },
    { 20240101, "Tables." },
    { 20240417, "Rule areas" },
    { 20240620, "Embedded Files" },
    { 20250222, "Hatched fills for shapes" },
    { 20250227, "Support for local power symbols" },
    { 20250318, "~ no longer means empty text" },
    { 20250827, "Custom body styles" },
    { 20250922, "Schematic variants." },
    { 20251028, "Updated properties formatting (do_not_autoplace, show_name)" },
    { 20260101, "PCB variants" },
    { 20260326, "Locking properties" },
    { 20260508, "Native ellipse primitive" },
    { 20260512, "Net chains" },
    { 20260629, "Pin-to-pad maps (issue #2282)" },
    { 20260722, "Dedicated variant symbol_override token" },
    { 20260818, "Line ending shapes" },
    { 20260830, "Custom user properties" },
};

static const VERSION_FEATURE SYMBOL_LIB_VERSION_FEATURES[] = {
    { 20220102, "Fonts." },
    { 20220126, "Text boxes." },
    { 20220331, "Text colors." },
    { 20220914, "Symbol unit display names." },
    { 20231120, "generator_version; V8 cleanups" },
    { 20240529, "Embedded Files" },
    { 20241209, "Private flags for SCH_FIELDs" },
    { 20250324, "Jumper pin groups" },
    { 20251024, "Updated properties formatting (do_not_autoplace, show_name)" },
    { 20260508, "Native ellipse primitive" },
    { 20260622, "Escaped special chars in stacked pin notation" },
    { 20260629, "Pin-to-pad maps (issue #2282)" },
    { 20260710, "Line ending shapes" },
    { 20260830, "Custom user properties" },
};

static const VERSION_FEATURE BOARD_VERSION_FEATURES[] = {
    { 20240202, "Tables" },
    { 20240225, "Rationalization of solder_paste_margin" },
    { 20240609, "Add 'tenting' keyword" },
    { 20240706, "Embedded Files" },
    { 20240928, "Component classes" },
    { 20240929, "Complex padstacks" },
    { 20241010, "Graphic shapes can have soldermask layer and margin" },
    { 20241030, "Dimension arrow directions, suppress_zeroes normalization" },
    { 20241228, "Convert teardrop curve points to bool" },
    { 20241229, "Expand User layers to arbitrary count" },
    { 20250222, "Hatching for PCB shapes" },
    { 20250309, "Component class dynamic assignment rules" },
    { 20250228, "ipc-4761 via protection features" },
    { 20250302, "Zone Hatching Offsets" },
    { 20250324, "Jumper pads" },
    { 20250401, "Time domain length tuning" },
    { 20250513, "Groups can have design block lib_id" },
    { 20250801, "(island) -> (island yes/no)" },
    { 20250909, "footprint unit metadata (units/pins)" },
    { 20250914, "Add support for PCB_BARCODE objects" },
    { 20251101, "Backdrill and tertiary drill support" },
    { 20260101, "PCB variants with per-footprint overrides" },
    { 20260410, "Extruded 3D body" },
    { 20260508, "Native ellipse primitive" },
    { 20260511, "Dielectric frequency-dependent models in board stackup" },
    { 20260512, "Net chains" },
    { 20260513, "Copper thieving zone fill mode" },
    { 20260521, "Pad simulation electrical types" },
    { 20260616, "Footprint affine transform: lib-frame storage and (transform) block" },
    { 20260624, "Geometric constraints (#2329)" },
    { 20260728, "Grid items" },
    { 20260816, "Via stitching and guarding" },
    { 20260818, "Line ending shapes" },
    { 20260828, "Exclude-from-simulation footprint attribute" },
    { 20260831, "Custom user properties" },
};


template <std::size_t N>
std::unordered_map<std::string_view, int> makeTable( const TOKEN_VERSION ( &aEntries )[N] )
{
    std::unordered_map<std::string_view, int> map;

    for( const TOKEN_VERSION& entry : aEntries )
        map.emplace( entry.m_token, entry.m_version );

    return map;
}


const std::unordered_map<std::string_view, int>& tokenTable( FILE_FORMAT_DOMAIN aDomain )
{
    static const std::unordered_map<std::string_view, int> schematic(
            makeTable( SCHEMATIC_TOKEN_VERSIONS ) );
    static const std::unordered_map<std::string_view, int> symbolLib(
            makeTable( SYMBOL_LIB_TOKEN_VERSIONS ) );
    static const std::unordered_map<std::string_view, int> board(
            makeTable( BOARD_TOKEN_VERSIONS ) );

    switch( aDomain )
    {
    case FILE_FORMAT_DOMAIN::SCHEMATIC:  return schematic;
    case FILE_FORMAT_DOMAIN::SYMBOL_LIB: return symbolLib;
    default:                             return board;
    }
}


/**
 * The table of words that impose a requirement when they appear in value position.
 *
 * Kept separate from tokenTable() so a word that is an ordinary value in one construct and a
 * token in another cannot raise a requirement from the wrong position.
 */
const std::unordered_map<std::string_view, int>& valueAtomTable( FILE_FORMAT_DOMAIN aDomain )
{
    static const std::unordered_map<std::string_view, int> schematic(
            makeTable( SCHEMATIC_VALUE_ATOM_VERSIONS ) );
    static const std::unordered_map<std::string_view, int> symbolLib(
            makeTable( SYMBOL_LIB_VALUE_ATOM_VERSIONS ) );
    static const std::unordered_map<std::string_view, int> board(
            makeTable( BOARD_VALUE_ATOM_VERSIONS ) );

    switch( aDomain )
    {
    case FILE_FORMAT_DOMAIN::SCHEMATIC:  return schematic;
    case FILE_FORMAT_DOMAIN::SYMBOL_LIB: return symbolLib;
    default:                             return board;
    }
}


/**
 * Name the format change that introduced @a aVersion, for a message to the user.
 */
const char* versionFeature( FILE_FORMAT_DOMAIN aDomain, int aVersion )
{
    auto search =
            []( const auto& aFeatures, int aWanted ) -> const char*
            {
                for( const VERSION_FEATURE& entry : aFeatures )
                {
                    if( entry.m_version == aWanted )
                        return entry.m_feature;
                }

                return nullptr;
            };

    switch( aDomain )
    {
    case FILE_FORMAT_DOMAIN::SCHEMATIC:  return search( SCHEMATIC_VERSION_FEATURES, aVersion );
    case FILE_FORMAT_DOMAIN::SYMBOL_LIB: return search( SYMBOL_LIB_VERSION_FEATURES, aVersion );
    default:                             return search( BOARD_VERSION_FEATURES, aVersion );
    }
}


bool isTokenStart( char aChar )
{
    return ( aChar >= 'a' && aChar <= 'z' ) || ( aChar >= 'A' && aChar <= 'Z' ) || aChar == '_';
}


bool isTokenChar( char aChar )
{
    return isTokenStart( aChar ) || ( aChar >= '0' && aChar <= '9' );
}

} // namespace


int FileFormatVersionStamp( const wxString& aFilePath )
{
    // The stamp is in the first s-expression of the file, so a short read is enough.
    wxFFile file( aFilePath, wxS( "rb" ) );

    if( !file.IsOpened() )
        return 0;

    char   buf[512] = { 0 };
    size_t got = file.Read( buf, sizeof( buf ) - 1 );

    if( got == 0 )
        return 0;

    const std::string_view head( buf, got );
    const size_t           at = head.find( "(version " );

    if( at == std::string_view::npos )
        return 0;

    int version = 0;

    for( size_t i = at + 9; i < head.size() && head[i] >= '0' && head[i] <= '9'; ++i )
        version = version * 10 + ( head[i] - '0' );

    return version;
}


bool UsesEscapedStackedPinNotation( const wxString& aPinNumber )
{
    const size_t len = aPinNumber.length();

    // Only bracketed notation is parsed as stacked; anything else is a literal pin number and
    // a backslash in it means a backslash in both the old and the new grammar.
    if( len < 3 || aPinNumber[0] != '[' || aPinNumber[len - 1] != ']' )
        return false;

    for( size_t i = 1; i + 1 < len; ++i )
    {
        if( aPinNumber[i] == '\\' )
            return true;
    }

    return false;
}


FORMAT_VERSION_REQUIREMENT MinimumFileFormatVersion( const std::string& aBody,
                                                     FILE_FORMAT_DOMAIN aDomain )
{
    const std::unordered_map<std::string_view, int>& tokens = tokenTable( aDomain );
    const std::unordered_map<std::string_view, int>& values = valueAtomTable( aDomain );

    FORMAT_VERSION_REQUIREMENT requirement;

    auto require =
            [&]( int aVersion, const char* aFeature )
            {
                if( aVersion > requirement.m_version )
                {
                    requirement.m_version = aVersion;
                    requirement.m_feature = aFeature;
                }
            };

    size_t       i = 0;
    const size_t n = aBody.size();

    while( i < n )
    {
        const char ch = aBody[i];

        if( ch == '"' )
        {
            // Skip the quoted atom: nothing inside it is a token, so a net, field or reference
            // whose text happens to match a token name cannot raise a requirement.
            size_t j = i + 1;

            while( j < n && aBody[j] != '"' )
                j += ( aBody[j] == '\\' ) ? 2 : 1;

            i = ( j < n ) ? j + 1 : n;
            continue;
        }

        if( ch == '(' )
        {
            size_t j = i + 1;

            if( j < n && isTokenStart( aBody[j] ) )
            {
                while( j < n && isTokenChar( aBody[j] ) )
                    ++j;

                const std::string_view token( aBody.data() + i + 1, j - i - 1 );

                if( auto it = tokens.find( token ); it != tokens.end() )
                    require( it->second, versionFeature( aDomain, it->second ) );
            }

            i = j;
            continue;
        }

        if( isTokenStart( ch ) )
        {
            // A bare identifier that is not directly after an open paren: a value, such as the
            // `exclude_from_sim` in `(attr smd exclude_from_sim)`.  Some grammar additions are
            // new values rather than new tokens, and an older lexer rejects those too.
            size_t j = i;

            while( j < n && isTokenChar( aBody[j] ) )
                ++j;

            const std::string_view atom( aBody.data() + i, j - i );

            if( auto it = values.find( atom ); it != values.end() )
                require( it->second, versionFeature( aDomain, it->second ) );

            i = j;
            continue;
        }

        ++i;
    }

    return requirement;
}


} // namespace KICAD_FORMAT
