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
 * Thin, synchronous REST client for the collaboration server (see COLLAB_SESSION
 * for the live WebSocket side).  All calls block the calling thread and return
 * std::nullopt on any transport or non-2xx failure.
 */
namespace COLLAB_REST
{

/// POST /api/join/{linkToken}: claim a share link -> { projectId, role }.
KICOMMON_API std::optional<nlohmann::json> ClaimLink( const wxString& aServerUrl,
                                                      const wxString& aToken,
                                                      const wxString& aLinkToken );

/// GET /api/projects/{id} -> { projectId, name, ownerId, role, docs: [ { docId, path, docType } ] }.
KICOMMON_API std::optional<nlohmann::json> GetProject( const wxString& aServerUrl,
                                                       const wxString& aToken,
                                                       const wxString& aProjectId );

/**
 * POST /api/projects (multipart): upload a zipped project.
 *
 * @param aZipBytes raw zip archive contents (sent as field "archive").
 * @return { projectId, name, docs: [ { docId, path, docType } ] }.
 */
KICOMMON_API std::optional<nlohmann::json> CreateProject( const wxString& aServerUrl,
                                                          const wxString& aToken,
                                                          const wxString& aName,
                                                          const std::string& aZipBytes );

/// POST /api/projects/{id}/links -> { token, url, role }.
KICOMMON_API std::optional<nlohmann::json> CreateShareLink( const wxString& aServerUrl,
                                                            const wxString& aToken,
                                                            const wxString& aProjectId,
                                                            const wxString& aRole );

/// GET /api/projects/{id}/archive -> raw zip bytes.
KICOMMON_API std::optional<std::string> DownloadArchive( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         const wxString& aProjectId );

/// POST /api/docs/{id}/snapshots?seq=N with a raw document body.
KICOMMON_API bool UploadSnapshot( const wxString& aServerUrl, const wxString& aToken,
                                  const wxString& aDocId, long long aSeq,
                                  const std::string& aBytes );

} // namespace COLLAB_REST
