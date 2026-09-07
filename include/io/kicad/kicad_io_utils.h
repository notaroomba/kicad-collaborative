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

#pragma once

#include <optional>
#include <string>

#include <wx/stream.h>
#include <wx/string.h>

#include <kicommon.h>

class OUTPUTFORMATTER;
class EDA_ITEM;
class KIID;

namespace KICAD_FORMAT {

/**
 * Which s-expression file format ledger a serialized body should be measured against.
 */
enum class FILE_FORMAT_DOMAIN
{
    SCHEMATIC,      ///< SEXPR_SCHEMATIC_FILE_VERSION (eeschema/sch_file_versions.h)
    SYMBOL_LIB,     ///< SEXPR_SYMBOL_LIB_FILE_VERSION (eeschema/sch_file_versions.h)
    BOARD           ///< SEXPR_BOARD_FILE_VERSION (pcb_io_kicad_sexpr.h)
};

/**
 * The oldest file format version that can carry a serialized body without loss.
 */
struct FORMAT_VERSION_REQUIREMENT
{
    int         m_version = 0;      ///< 0 when nothing in the body demands a particular version
    const char* m_feature = nullptr;///< untranslated name of the feature that demands it
};

/**
 * Determine the oldest file format version that can represent @a aBody without losing data.
 *
 * KiCad's writers have no per-token version gating: they always emit the current grammar.  A
 * caller that wants to keep a file at the version it was loaded with therefore has to know
 * whether the bytes it is about to write actually fit in that older version.  This scans the
 * already-serialized body and returns the newest format version any of it requires, so the
 * caller can either keep the old stamp (when the requirement is met) or raise it and say why.
 *
 * Two kinds of requirement are recognised:
 *  - tokens that did not exist in the older grammar (an old KiCad would reject the file), and
 *  - constructs whose *meaning* changed, which an old KiCad would silently misread.
 *
 * The scan is quoting-aware: identifiers inside quoted atoms are skipped entirely, so a net or
 * field whose text happens to match a token name cannot trigger a false requirement.  Two
 * positions are examined: identifiers in token position (directly after an unquoted open paren),
 * and bare unquoted identifiers in value position.  The latter matter because some grammar
 * additions are not new tokens at all but new *values* of an existing one -- `(attr ...
 * exclude_from_sim)` and `(property pad_prop_pressfit)` are written as bare atoms, and an older
 * lexer rejects them just as hard as an unknown token.  Value-position atoms are matched against
 * their own table so that a word which is a token in one place and an ordinary value in another
 * cannot cross-fire.
 *
 * Unknown constructs produce no requirement, so this can under-report for grammar changes it
 * has no entry for; it never over-reports for quoted content.
 *
 * @param aBody is the serialized s-expression body, without its `(kicad_sch`/`(kicad_pcb` header.
 * @param aDomain selects the schematic or board token table.
 * @return the requirement; m_version is 0 when the body imposes none.
 */
KICOMMON_API FORMAT_VERSION_REQUIREMENT MinimumFileFormatVersion( const std::string& aBody,
                                                                  FILE_FORMAT_DOMAIN aDomain );

/**
 * Test whether a pin number uses the escaped form of stacked pin notation (20260622).
 *
 * Stacked pin notation packs several numbers into one pin's number field as [A,B,C].  Since
 * 20260622 the structural characters `[`, `]`, `,`, `-` and `\` are backslash-escaped inside
 * each packed number, and the parser splits only on unescaped separators.
 *
 * This is invisible to MinimumFileFormatVersion(): the escaped text lives inside a quoted atom,
 * which the scan skips, and no token changed.  It is also the worst kind of format change to get
 * wrong -- a pre-20260622 KiCad reads `[A\-1,A\-2]` as a range and a literal backslash, so the
 * file opens cleanly and means something else.  Writers that may keep an older stamp must
 * therefore ask the model.
 *
 * @param aPinNumber is the pin's number field as stored.
 * @return true when the value can only be read correctly by 20260622 or newer.
 */
KICOMMON_API bool UsesEscapedStackedPinNotation( const wxString& aPinNumber );

/**
 * Read the `(version N)` stamp out of a KiCad s-expression file without parsing it.
 *
 * For paths that move design files around as bytes -- a collaboration join unpacking an archive,
 * a local-history restore overlaying a snapshot -- which never go through a writer and so cannot
 * honour a preserved version.  Those paths use this to notice, and say, that a file's format
 * version was raised behind the user's back.
 *
 * @param aFilePath is the file to inspect.
 * @return the declared version, or 0 when the file is unreadable or declares none.
 */
KICOMMON_API int FileFormatVersionStamp( const wxString& aFilePath );

/**
 * Writes a boolean to the formatter, in the style (aKey [yes|no])
 *
 * @param aOut is the output formatter to write to
 * @param aKey is the name of the boolean flag
 * @param aValue is the value to write
 */
KICOMMON_API void FormatBool( OUTPUTFORMATTER* aOut, const wxString& aKey, bool aValue );

/**
 * Writes an optional boolean to the formatter.
 * If a value is present, calls FormatBool.
 * If no value is present, Writes (aKey none).
 * 
 * @param aOut is the output formatter to write to
 * @param aKey is the name of the boolean flag
 * @param aValue is the value to write
 */
KICOMMON_API void FormatOptBool( OUTPUTFORMATTER* aOut, const wxString& aKey,
                                 std::optional<bool> aValue );

KICOMMON_API void FormatUuid( OUTPUTFORMATTER* aOut, const KIID& aUuid );

/**
 * Writes the item's custom properties as a series of `(custom_property "key" "value")`
 *
 * @param aOut is the output formatter to write to
 * @param aItem is the item to write properties of
 */
KICOMMON_API void FormatCustomProperties( OUTPUTFORMATTER* aOut, const EDA_ITEM& aItem );

/**
 * Write binary data to the formatter as base 64 encoded string.
 */
KICOMMON_API void FormatStreamData( OUTPUTFORMATTER& aOut, const wxStreamBuffer& aStream );

/**
 * Controls the pretty-printing mode used by Prettify
 */
enum class KICOMMON_API FORMAT_MODE
{
    NORMAL,                     ///< Follows standard pretty-printing rules
    COMPACT_TEXT_PROPERTIES,    ///< Collapses certain text properties to single-line
    LIBRARY_TABLE               ///< Puts library table rows on a single line
};

/**
 * Pretty-prints s-expression text according to KiCad format rules
 *
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
KICOMMON_API void Prettify( std::string& aSource, FORMAT_MODE aMode = FORMAT_MODE::NORMAL );

} // namespace KICAD_FORMAT
