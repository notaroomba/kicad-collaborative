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
 * std::nullopt (or false) on any transport or non-2xx failure.  Calls that take an
 * ERROR_INFO fill it in to say why that very request failed.
 */
namespace COLLAB_REST
{

/// Why a request failed, for calls that take one as their last argument.
struct ERROR_INFO
{
    /// The HTTP status of the response; 0 when the server could not be reached at all.
    int      status = 0;

    /// The server's own explanation (the "message" of its JSON error body), or empty.
    wxString message;
};

/**
 * A translated sentence for the user about a failed request: the connection, the sign-in,
 * the permission, or else whatever the server said about it.
 */
KICOMMON_API wxString DescribeError( const ERROR_INFO& aError );

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

/// POST /api/projects/{id}/links { role, expiresInDays? } -> { token, url, role }.
/// The link never expires unless aExpiresInDays is positive.
KICOMMON_API std::optional<nlohmann::json> CreateShareLink( const wxString& aServerUrl,
                                                            const wxString& aToken,
                                                            const wxString& aProjectId,
                                                            const wxString& aRole,
                                                            int aExpiresInDays = 0,
                                                            ERROR_INFO* aError = nullptr );

/// GET /api/projects/{id}/fonts/file?family=&bold=&italic=&exact=1 -> the font file of exactly
/// that style, when the project (or Google Fonts, through the server) has it.
KICOMMON_API std::optional<std::string> DownloadProjectFont( const wxString& aServerUrl,
                                                             const wxString& aToken,
                                                             const wxString& aProjectId,
                                                             const wxString& aFamily, bool aBold,
                                                             bool aItalic );

/// PUT /api/projects/{id}/fonts/file?family=&bold=&italic=&index=&name= with the font file:
/// keep a font of this computer with the project.  Refused (403, with the reason) when the
/// font's embedding permission forbids it.
KICOMMON_API bool UploadProjectFont( const wxString& aServerUrl, const wxString& aToken,
                                     const wxString& aProjectId, const wxString& aFamily,
                                     bool aBold, bool aItalic, int aFaceIndex,
                                     const wxString& aFileName, const std::string& aBytes,
                                     ERROR_INFO* aError = nullptr );

/// GET /api/projects/{id}/fonts -> { fonts: [ { family, styles: [ { bold, italic } ] } ] }:
/// the fonts uploaded into the project.
KICOMMON_API std::optional<nlohmann::json> ListProjectFonts( const wxString& aServerUrl,
                                                             const wxString& aToken,
                                                             const wxString& aProjectId );

/// GET /api/projects/{id}/archive -> raw zip bytes.
KICOMMON_API std::optional<std::string> DownloadArchive( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         const wxString& aProjectId );

/// POST /api/docs/{id}/snapshots?seq=N with a raw document body.
KICOMMON_API bool UploadSnapshot( const wxString& aServerUrl, const wxString& aToken,
                                  const wxString& aDocId, long long aSeq,
                                  const std::string& aBytes );

/// GET /api/projects -> { projects: [ { projectId, name, description, ownerId, ownerLogin,
/// ownerAvatarUrl, role, public, docCount, memberCount, starred, createdAt, updatedAt } ] },
/// most recently edited first.
KICOMMON_API std::optional<nlohmann::json> ListProjects( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         ERROR_INFO* aError = nullptr );

/// DELETE /api/projects/{id} (owner only): moves the project to the Trash, where it can be
/// restored for 30 days.  It is gone for every collaborator at once.
KICOMMON_API bool DeleteProject( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId,
                                 ERROR_INFO* aError = nullptr );

/// POST /api/projects/{id}/leave: give up our own membership (not for owners).
KICOMMON_API bool LeaveProject( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId,
                                ERROR_INFO* aError = nullptr );

/// PATCH /api/projects/{id} { name } (owner only).
KICOMMON_API bool RenameProject( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId, const wxString& aName,
                                 ERROR_INFO* aError = nullptr );

/// GET /api/trash -> { projects: [ { projectId, name, docCount, deletedAt, purgeAt } ] }:
/// the caller's own deleted projects that can still be restored, latest first.
KICOMMON_API std::optional<nlohmann::json> ListTrash( const wxString& aServerUrl,
                                                      const wxString& aToken,
                                                      ERROR_INFO* aError = nullptr );

/// POST /api/projects/{id}/undelete (owner only): take a project back out of the Trash.
KICOMMON_API bool UndeleteProject( const wxString& aServerUrl, const wxString& aToken,
                                   const wxString& aProjectId, ERROR_INFO* aError = nullptr );

/// DELETE /api/projects/{id}?permanent=true (owner only): destroy a project, in the Trash
/// or not, for good.
KICOMMON_API bool PurgeProject( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId, ERROR_INFO* aError = nullptr );

/// PUT or DELETE /api/projects/{id}/star: pin a project to the top of the caller's own list.
KICOMMON_API bool SetStar( const wxString& aServerUrl, const wxString& aToken,
                           const wxString& aProjectId, bool aStarred,
                           ERROR_INFO* aError = nullptr );

/// POST /api/projects/{id}/transfer { userId } (owner only): hand the project to someone
/// who already has access; the caller stays on as an editor.
KICOMMON_API bool TransferProject( const wxString& aServerUrl, const wxString& aToken,
                                   const wxString& aProjectId, long long aUserId,
                                   ERROR_INFO* aError = nullptr );

/// POST /api/projects/blank { name } -> { projectId, name, docs: [ { docId, path, docType } ] }:
/// a new project holding an empty .kicad_pro, schematic and board.
KICOMMON_API std::optional<nlohmann::json> CreateBlankProject( const wxString& aServerUrl,
                                                               const wxString& aToken,
                                                               const wxString& aName,
                                                               ERROR_INFO* aError = nullptr );

/// POST /api/projects/{id}/clone -> { projectId, name }: a private copy, owned by the
/// caller, of a project the caller can see.
KICOMMON_API std::optional<nlohmann::json> CloneProject( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         const wxString& aProjectId,
                                                         ERROR_INFO* aError = nullptr );

/// PATCH /api/projects/{id} { name, description } (owner only).
KICOMMON_API bool UpdateProjectDetails( const wxString& aServerUrl, const wxString& aToken,
                                        const wxString& aProjectId, const wxString& aName,
                                        const wxString& aDescription,
                                        ERROR_INFO* aError = nullptr );

/// PATCH /api/projects/{id} { public } (owner only): gallery visibility.
KICOMMON_API bool SetProjectPublic( const wxString& aServerUrl, const wxString& aToken,
                                    const wxString& aProjectId, bool aPublic,
                                    ERROR_INFO* aError = nullptr );

/// GET /api/users/search?q= -> { users: [ { login, name, avatarUrl, userId, source } ] }
/// where source is "server" (has an account here) or "github".
KICOMMON_API std::optional<nlohmann::json> SearchUsers( const wxString& aServerUrl,
                                                        const wxString& aToken,
                                                        const wxString& aQuery,
                                                        ERROR_INFO* aError = nullptr );

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
                                                   const wxString& aRole,
                                                   ERROR_INFO* aError = nullptr );

/// GET /api/projects/{id}/members (any member; read-only for non-owners) ->
/// { ownerId, owner: { userId, login, avatarUrl }, canManage, members: [ { userId, login,
/// avatarUrl, role } ], pending: [ { inviteId, login, email, role } ] }.  pending is empty
/// unless canManage.
KICOMMON_API std::optional<nlohmann::json> ListMembers( const wxString& aServerUrl,
                                                        const wxString& aToken,
                                                        const wxString& aProjectId,
                                                        ERROR_INFO* aError = nullptr );

/// DELETE /api/projects/{id}/members/{userId} (owner only).
KICOMMON_API bool RemoveMember( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId, long long aUserId,
                                ERROR_INFO* aError = nullptr );

/// DELETE /api/projects/{id}/invites/{inviteId} (owner only).
KICOMMON_API bool RevokeInvite( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId, long long aInviteId,
                                ERROR_INFO* aError = nullptr );

/// PATCH /api/projects/{id}/members/{userId} { role: "editor"|"commenter"|"viewer" } (owner only).
KICOMMON_API bool SetMemberRole( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId, long long aUserId,
                                 const wxString& aRole,
                                 ERROR_INFO* aError = nullptr );

/// PATCH /api/projects/{id}/invites/{inviteId} { role: "editor"|"commenter"|"viewer" } (owner only).
KICOMMON_API bool SetInviteRole( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId, long long aInviteId,
                                 const wxString& aRole,
                                 ERROR_INFO* aError = nullptr );

/// GET /api/projects/{id}/links (owner only) -> { links: [ { token, url, role, createdAt,
/// expiresAt|null } ] }, active links only.
KICOMMON_API std::optional<nlohmann::json> ListShareLinks( const wxString& aServerUrl,
                                                           const wxString& aToken,
                                                           const wxString& aProjectId,
                                                           ERROR_INFO* aError = nullptr );

/// DELETE /api/links/{token} (owner only): the link stops working; people who already
/// joined through it keep their access.
KICOMMON_API bool RevokeShareLink( const wxString& aServerUrl, const wxString& aToken,
                                   const wxString& aLinkToken,
                                   ERROR_INFO* aError = nullptr );

/// GET /api/me -> { id, login, name, email, avatarUrl }.
/// POST /api/projects/{id}/docs — add a document mid-session (idempotent by
/// path); returns { docId, path, docType, existing }.
KICOMMON_API std::optional<nlohmann::json> CreateDoc( const wxString& aServerUrl,
                                                      const wxString& aToken,
                                                      const wxString& aProjectId,
                                                      const wxString& aPath );

/// GET /api/docs/{id}/content — the latest snapshot bytes (empty on failure).
KICOMMON_API std::string FetchDocContent( const wxString& aServerUrl, const wxString& aToken,
                                          const wxString& aDocId );

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

/// GET /api/projects/{id}/versions -> { versions: [ { id, name, kind, author, createdAt, docs } ] }
/// Saved versions (kind "named") and the ones the server keeps by itself before a restore
/// or a merge (kind "auto"), newest first.
KICOMMON_API std::optional<nlohmann::json> ListVersions( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         const wxString& aProjectId );

/// POST /api/projects/{id}/restore { versionId } — editors; the project as it is now is
/// kept as a version first, and live editors reconcile from the reset broadcast.
KICOMMON_API std::optional<nlohmann::json> RestoreVersion( const wxString& aServerUrl,
                                                           const wxString& aToken,
                                                           const wxString& aProjectId,
                                                           const wxString& aVersionId );

/// POST /api/projects/{id}/restore { name } — the newest version with this name.  Kept for
/// callers that only know a name; live editors reconcile from the reset broadcast.
KICOMMON_API std::optional<nlohmann::json> RestoreCheckpoint( const wxString& aServerUrl,
                                                              const wxString& aToken,
                                                              const wxString& aProjectId,
                                                              const wxString& aName );

/// GET /api/docs/{id}/comments -> { comments: [...] }
KICOMMON_API std::optional<nlohmann::json> ListComments( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         const wxString& aDocId );

/// POST a new comment (aParentId < 0 for a new thread at aX/aY nm).  aAnchor, when an object,
/// pins a new thread to what it is about: {kind: "item", id, label} or
/// {kind: "net", id, label, item}.
KICOMMON_API std::optional<nlohmann::json> CreateComment( const wxString& aServerUrl,
                                                          const wxString& aToken,
                                                          const wxString& aDocId,
                                                          const wxString& aBody, long long aX,
                                                          long long aY, long long aParentId,
                                                          const nlohmann::json& aAnchor = nlohmann::json() );

KICOMMON_API bool SetCommentResolved( const wxString& aServerUrl, const wxString& aToken,
                                      long long aCommentId, bool aResolved );

KICOMMON_API std::optional<nlohmann::json> Me( const wxString& aServerUrl,
                                              const wxString& aToken,
                                               ERROR_INFO* aError = nullptr );

} // namespace COLLAB_REST
