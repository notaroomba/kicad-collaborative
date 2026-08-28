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

#include <optional>
#include <string>

#include <kicommon.h>
#include <nlohmann/json.hpp>
#include <wx/string.h>

/**
 * Project-level collaboration plumbing shared by the editors: packaging a
 * project for upload, and the REST sequences behind "Start Collaboration
 * Session" and "Join Shared Project".  Everything here is synchronous and
 * free of UI; the caller reports aError however it likes.
 */
namespace COLLAB_PROJECT
{

/// Zip the shareable files in aProjectPath (top level only); empty on failure.
KICOMMON_API std::string ZipProjectFiles( const wxString& aProjectPath );

/**
 * Upload aProjectPath as a new server project and mint an editor share link.
 *
 * @param aShareUrl is set to the share link URL on success.
 * @param aError is set to a translated message on failure.
 * @return the server project json, or std::nullopt on failure.
 */
KICOMMON_API std::optional<nlohmann::json> CreateAndShare( const wxString& aServer,
                                                           const wxString& aToken,
                                                           const wxString& aProjectPath,
                                                           const wxString& aProjectName,
                                                           wxString& aShareUrl,
                                                           wxString& aError );

/**
 * Claim a share link and fetch the project it points at.
 *
 * @param aError is set to a translated message on failure.
 * @return the server project json, or std::nullopt on failure.
 */
KICOMMON_API std::optional<nlohmann::json> ClaimAndFetch( const wxString& aServer,
                                                          const wxString& aToken,
                                                          const wxString& aLinkToken,
                                                          wxString& aError );

/// "https://host/j/TOKEN" or a bare token -> TOKEN (empty if unparseable).
KICOMMON_API wxString ParseLinkToken( const wxString& aInput );

} // namespace COLLAB_PROJECT
