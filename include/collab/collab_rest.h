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

/// GET /api/projects -> { projects: [ { projectId, name, ownerId, ownerLogin, role,
/// docCount, createdAt, updatedAt } ] }, most recently edited first.
KICOMMON_API std::optional<nlohmann::json> ListProjects( const wxString& aServerUrl,
                                                         const wxString& aToken );

/// DELETE /api/projects/{id} (owner only).
KICOMMON_API bool DeleteProject( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId );

/// PATCH /api/projects/{id} { name } (owner only).
KICOMMON_API bool RenameProject( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId, const wxString& aName );

/// PATCH /api/projects/{id} { public } (owner only): gallery visibility.
KICOMMON_API bool SetProjectPublic( const wxString& aServerUrl, const wxString& aToken,
                                    const wxString& aProjectId, bool aPublic );

/// GET /api/users/search?q= -> { users: [ { login, name, avatarUrl, userId, source } ] }
/// where source is "server" (has an account here) or "github".
KICOMMON_API std::optional<nlohmann::json> SearchUsers( const wxString& aServerUrl,
                                                        const wxString& aToken,
                                                        const wxString& aQuery );

/**
 * POST /api/projects/{id}/invites: grant by GitHub login or email (owner only).
 * -> { ok, status: "granted"|"pending", ... }.  Exactly one of login/email is used;
 * pass the other empty.
 */
KICOMMON_API std::optional<nlohmann::json> Invite( const wxString& aServerUrl,
                                                   const wxString& aToken,
                                                   const wxString& aProjectId,
                                                   const wxString& aLogin,
                                                   const wxString& aEmail,
                                                   const wxString& aRole );

/// GET /api/projects/{id}/members -> { ownerId, members: [...], pending: [...] } (owner only).
KICOMMON_API std::optional<nlohmann::json> ListMembers( const wxString& aServerUrl,
                                                        const wxString& aToken,
                                                        const wxString& aProjectId );

/// DELETE /api/projects/{id}/members/{userId} (owner only).
KICOMMON_API bool RemoveMember( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId, long long aUserId );

/// DELETE /api/projects/{id}/invites/{inviteId} (owner only).
KICOMMON_API bool RevokeInvite( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId, long long aInviteId );

/// GET /api/me -> { id, login, name, email, avatarUrl }.
/// POST /api/docs/{id}/preview?seq=N&fit=... — a client-rendered SVG preview.
KICOMMON_API bool UploadPreview( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aDocId, long long aSeq, bool aFit,
                                 const std::string& aSvg );

/// GET /api/projects/{id}/checkpoints -> { checkpoints: [ { name, docId, path, seq, createdAt } ] }
KICOMMON_API std::optional<nlohmann::json> ListCheckpoints( const wxString& aServerUrl,
                                                            const wxString& aToken,
                                                            const wxString& aProjectId );

/// POST /api/projects/{id}/checkpoints { name }
KICOMMON_API std::optional<nlohmann::json> CreateCheckpoint( const wxString& aServerUrl,
                                                             const wxString& aToken,
                                                             const wxString& aProjectId,
                                                             const wxString& aName );

/// POST /api/projects/{id}/restore { name } — owner only; live editors
/// reconcile automatically from the reset broadcast.
KICOMMON_API std::optional<nlohmann::json> RestoreCheckpoint( const wxString& aServerUrl,
                                                              const wxString& aToken,
                                                              const wxString& aProjectId,
                                                              const wxString& aName );

/// GET /api/docs/{id}/comments -> { comments: [...] }
KICOMMON_API std::optional<nlohmann::json> ListComments( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         const wxString& aDocId );

/// POST a new comment (aParentId < 0 for a new thread at aX/aY nm).
KICOMMON_API std::optional<nlohmann::json> CreateComment( const wxString& aServerUrl,
                                                          const wxString& aToken,
                                                          const wxString& aDocId,
                                                          const wxString& aBody, long long aX,
                                                          long long aY, long long aParentId );

KICOMMON_API bool SetCommentResolved( const wxString& aServerUrl, const wxString& aToken,
                                      long long aCommentId, bool aResolved );

KICOMMON_API std::optional<nlohmann::json> Me( const wxString& aServerUrl,
                                              const wxString& aToken );

} // namespace COLLAB_REST
