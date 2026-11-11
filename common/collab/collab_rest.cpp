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

// kicad_curl.h (and thus curl.h) must be included before any wxWidgets headers.
#include <kicad_curl/kicad_curl.h>
#include <kicad_curl/kicad_curl_easy.h>

#include <collab/collab_rest.h>

#include <wx/intl.h>
#include <wx/log.h>

static const wxChar* const traceCollab = wxT( "COLLAB" );


static void setupRequest( KICAD_CURL_EASY& aCurl, const wxString& aUrl, const wxString& aToken )
{
    aCurl.SetURL( aUrl.ToStdString( wxConvUTF8 ) );
    aCurl.SetHeader( "Authorization", "Bearer " + aToken.ToStdString( wxConvUTF8 ) );
    aCurl.SetHeader( "Accept", "application/json" );
    aCurl.SetTimeout( 60 );
}


static void setJsonBody( KICAD_CURL_EASY& aCurl, const nlohmann::json& aBody );


/// The "message" of the server's JSON error body ({ "error": ..., "message": ... }), or empty.
static wxString serverMessage( const std::string& aBody )
{
    nlohmann::json body = nlohmann::json::parse( aBody, nullptr, /* allow_exceptions */ false );

    if( !body.is_object() )
        return wxEmptyString;

    auto it = body.find( "message" );

    if( it == body.end() || !it->is_string() )
        return wxEmptyString;

    return wxString::FromUTF8( it->get<std::string>() );
}


/// Perform the request; true when the transfer succeeded with a 2xx status.  Otherwise
/// aError, when given, says what went wrong.
static bool performOk( KICAD_CURL_EASY& aCurl, COLLAB_REST::ERROR_INFO* aError = nullptr )
{
    int rc = aCurl.Perform();
    int status = aCurl.GetResponseStatusCode();

    if( aError )
        *aError = COLLAB_REST::ERROR_INFO();

    if( rc != 0 || status < 200 || status >= 300 )
    {
        wxLogTrace( traceCollab, wxS( "REST request failed: curl=%d http=%d body=%s" ), rc, status,
                    wxString::FromUTF8( aCurl.GetBuffer() ) );

        // A transfer that broke off has no status worth reporting, whatever curl left there.
        if( aError && rc == 0 )
        {
            aError->status = status;
            aError->message = serverMessage( aCurl.GetBuffer() );
        }

        return false;
    }

    if( aError )
        aError->status = status;

    return true;
}


static std::optional<nlohmann::json> performJson( KICAD_CURL_EASY& aCurl,
                                                  COLLAB_REST::ERROR_INFO* aError = nullptr )
{
    if( !performOk( aCurl, aError ) )
        return std::nullopt;

    try
    {
        return nlohmann::json::parse( aCurl.GetBuffer() );
    }
    catch( const std::exception& e )
    {
        wxLogTrace( traceCollab, wxS( "REST response parse error: %s" ), e.what() );

        if( aError )
            aError->message = _( "The server sent a reply that could not be understood." );

        return std::nullopt;
    }
}


/// An empty POST: the URL says it all.
static void setEmptyPost( KICAD_CURL_EASY& aCurl )
{
    curl_easy_setopt( aCurl.GetCurl(), CURLOPT_POSTFIELDS, "" );
    curl_easy_setopt( aCurl.GetCurl(), CURLOPT_POSTFIELDSIZE, 0L );
}


/// PATCH /api/projects/{id} with aChanges (owner only).
static bool patchProject( const wxString& aServerUrl, const wxString& aToken,
                          const wxString& aProjectId, const nlohmann::json& aChanges,
                          COLLAB_REST::ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId, aToken );

    setJsonBody( curl, aChanges );
    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "PATCH" );

    return performOk( curl, aError );
}


wxString COLLAB_REST::DescribeError( const ERROR_INFO& aError )
{
    if( aError.status == 0 && aError.message.IsEmpty() )
        return _( "Could not reach the server.  Check your network connection." );

    switch( aError.status )
    {
    case 401: return _( "Your sign-in is no longer valid.  Sign out and sign in again." );
    case 403: return _( "You do not have permission to do this." );
    case 404: return _( "It no longer exists, or you no longer have access to it." );
    default:  break;
    }

    if( aError.message.IsEmpty() )
        return wxString::Format( _( "The server reported an error (HTTP %d)." ), aError.status );

    // The server words its messages as lower-case fragments ("that user owns this project").
    wxString message = aError.message;

    message[0] = wxToupper( message[0] );

    if( !message.EndsWith( wxS( "." ) ) && !message.EndsWith( wxS( "!" ) )
        && !message.EndsWith( wxS( "?" ) ) )
    {
        message += wxS( "." );
    }

    return message;
}


/// Attach a JSON request body.  The label matters as much as the bytes: the server's JSON
/// extractor answers 415 to anything but application/json, and libcurl's default label for a
/// POST body is application/x-www-form-urlencoded -- checkpoints, restores, comments and new
/// sheet docs all failed on exactly that while the requests that set the header worked.
static void setJsonBody( KICAD_CURL_EASY& aCurl, const nlohmann::json& aBody )
{
    aCurl.SetHeader( "Content-Type", "application/json" );
    aCurl.SetPostFields( aBody.dump() );
}


std::optional<nlohmann::json> COLLAB_REST::ClaimLink( const wxString& aServerUrl,
                                                      const wxString& aToken,
                                                      const wxString& aLinkToken )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/join/" ) + aLinkToken, aToken );

    // Empty POST body; the link token in the URL is the payload.
    curl.SetPostFields( std::string() );

    return performJson( curl );
}


std::optional<nlohmann::json> COLLAB_REST::GetProject( const wxString& aServerUrl,
                                                       const wxString& aToken,
                                                       const wxString& aProjectId )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId, aToken );

    return performJson( curl );
}


std::optional<nlohmann::json> COLLAB_REST::CreateProject( const wxString& aServerUrl,
                                                          const wxString& aToken,
                                                          const wxString& aName,
                                                          const std::string& aZipBytes )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects" ), aToken );

    std::string nameUtf8 = aName.ToStdString( wxConvUTF8 );

    curl_mime*     mime = curl_mime_init( curl.GetCurl() );
    curl_mimepart* part = curl_mime_addpart( mime );

    curl_mime_name( part, "archive" );
    curl_mime_filename( part, "project.zip" );
    curl_mime_type( part, "application/zip" );
    curl_mime_data( part, aZipBytes.data(), aZipBytes.size() );

    part = curl_mime_addpart( mime );
    curl_mime_name( part, "name" );
    curl_mime_data( part, nameUtf8.c_str(), CURL_ZERO_TERMINATED );

    curl_easy_setopt( curl.GetCurl(), CURLOPT_MIMEPOST, mime );

    std::optional<nlohmann::json> result = performJson( curl );

    curl_mime_free( mime );

    return result;
}


std::optional<nlohmann::json> COLLAB_REST::CreateShareLink( const wxString& aServerUrl,
                                                            const wxString& aToken,
                                                            const wxString& aProjectId,
                                                            const wxString& aRole,
                                                            int aExpiresInDays,
                                                            ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/links" ),
                  aToken );

    nlohmann::json body = {
        { "role", aRole.ToStdString( wxConvUTF8 ) },
    };

    if( aExpiresInDays > 0 )
        body[ "expiresInDays" ] = aExpiresInDays;

    setJsonBody( curl, body );

    return performJson( curl, aError );
}


std::optional<std::string> COLLAB_REST::DownloadArchive( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         const wxString& aProjectId )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/archive" ),
                  aToken );

    if( !performOk( curl ) )
        return std::nullopt;

    return curl.GetBuffer();
}


bool COLLAB_REST::UploadSnapshot( const wxString& aServerUrl, const wxString& aToken,
                                  const wxString& aDocId, long long aSeq,
                                  const std::string& aBytes )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl,
                  wxString::Format( wxS( "%s/api/docs/%s/snapshots?seq=%lld" ), aServerUrl,
                                    aDocId, aSeq ),
                  aToken );

    curl.SetHeader( "Content-Type", "application/octet-stream" );

    // SetPostFields() would stop at the first NUL byte; set the size first so the
    // whole (possibly binary) body is copied.
    curl_easy_setopt( curl.GetCurl(), CURLOPT_POSTFIELDSIZE_LARGE,
                      static_cast<curl_off_t>( aBytes.size() ) );
    curl_easy_setopt( curl.GetCurl(), CURLOPT_COPYPOSTFIELDS, aBytes.data() );

    return performOk( curl );
}


std::optional<nlohmann::json> COLLAB_REST::ListProjects( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects" ), aToken );

    return performJson( curl, aError );
}


bool COLLAB_REST::DeleteProject( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId,
                                 ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId, aToken );

    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "DELETE" );

    return performOk( curl, aError );
}


bool COLLAB_REST::LeaveProject( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId,
                                ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/leave" ),
                  aToken );

    setEmptyPost( curl );

    return performOk( curl, aError );
}


bool COLLAB_REST::RenameProject( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId, const wxString& aName,
                                 ERROR_INFO* aError )
{
    return patchProject( aServerUrl, aToken, aProjectId,
                         { { "name", aName.ToStdString( wxConvUTF8 ) } }, aError );
}


bool COLLAB_REST::UpdateProjectDetails( const wxString& aServerUrl, const wxString& aToken,
                                        const wxString& aProjectId, const wxString& aName,
                                        const wxString& aDescription, ERROR_INFO* aError )
{
    return patchProject( aServerUrl, aToken, aProjectId,
                         { { "name", aName.ToStdString( wxConvUTF8 ) },
                           { "description", aDescription.ToStdString( wxConvUTF8 ) } },
                         aError );
}


bool COLLAB_REST::SetProjectPublic( const wxString& aServerUrl, const wxString& aToken,
                                    const wxString& aProjectId, bool aPublic,
                                    ERROR_INFO* aError )
{
    return patchProject( aServerUrl, aToken, aProjectId, { { "public", aPublic } }, aError );
}


std::optional<nlohmann::json> COLLAB_REST::ListTrash( const wxString& aServerUrl,
                                                      const wxString& aToken,
                                                      ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/trash" ), aToken );

    return performJson( curl, aError );
}


bool COLLAB_REST::UndeleteProject( const wxString& aServerUrl, const wxString& aToken,
                                   const wxString& aProjectId, ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/undelete" ),
                  aToken );

    setEmptyPost( curl );

    return performOk( curl, aError );
}


bool COLLAB_REST::PurgeProject( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId, ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl,
                  aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "?permanent=true" ),
                  aToken );

    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "DELETE" );

    return performOk( curl, aError );
}


bool COLLAB_REST::SetStar( const wxString& aServerUrl, const wxString& aToken,
                           const wxString& aProjectId, bool aStarred, ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/star" ),
                  aToken );

    // PUT without a body: as a custom request so that curl does not wait for an upload.
    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, aStarred ? "PUT" : "DELETE" );

    return performOk( curl, aError );
}


bool COLLAB_REST::TransferProject( const wxString& aServerUrl, const wxString& aToken,
                                   const wxString& aProjectId, long long aUserId,
                                   ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/transfer" ),
                  aToken );

    nlohmann::json body = { { "userId", aUserId } };

    setJsonBody( curl, body );

    return performOk( curl, aError );
}


std::optional<nlohmann::json> COLLAB_REST::CreateBlankProject( const wxString& aServerUrl,
                                                               const wxString& aToken,
                                                               const wxString& aName,
                                                               ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/blank" ), aToken );

    nlohmann::json body = { { "name", aName.ToStdString( wxConvUTF8 ) } };

    setJsonBody( curl, body );

    return performJson( curl, aError );
}


std::optional<nlohmann::json> COLLAB_REST::CloneProject( const wxString& aServerUrl,
                                                         const wxString& aToken,
                                                         const wxString& aProjectId,
                                                         ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/clone" ),
                  aToken );

    // This one endpoint only looks at the web session cookie.  The bearer token is the
    // very same session token, so it is presented that way as well.
    curl.SetHeader( "Cookie", "kc_session=" + aToken.ToStdString( wxConvUTF8 ) );

    setEmptyPost( curl );

    return performJson( curl, aError );
}


std::optional<nlohmann::json> COLLAB_REST::SearchUsers( const wxString& aServerUrl,
                                                        const wxString& aToken,
                                                        const wxString& aQuery,
                                                        ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;

    std::string escaped = curl.Escape( aQuery.ToStdString( wxConvUTF8 ) );

    setupRequest( curl, aServerUrl + wxS( "/api/users/search?q=" ) + wxString::FromUTF8( escaped ),
                  aToken );

    // Typeahead: fail fast rather than hanging the dialog.
    curl.SetTimeout( 10 );

    return performJson( curl, aError );
}


std::optional<nlohmann::json> COLLAB_REST::Invite( const wxString& aServerUrl,
                                                   const wxString& aToken,
                                                   const wxString& aProjectId,
                                                   const wxString& aLogin,
                                                   const wxString& aEmail,
                                                   const wxString& aRole,
                                                   ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/invites" ),
                  aToken );

    nlohmann::json body = { { "role", aRole.ToStdString( wxConvUTF8 ) } };

    if( !aLogin.IsEmpty() )
        body[ "login" ] = aLogin.ToStdString( wxConvUTF8 );
    else if( !aEmail.IsEmpty() )
        body[ "email" ] = aEmail.ToStdString( wxConvUTF8 );

    setJsonBody( curl, body );

    return performJson( curl, aError );
}


std::optional<nlohmann::json> COLLAB_REST::ListMembers( const wxString& aServerUrl,
                                                        const wxString& aToken,
                                                        const wxString& aProjectId,
                                                        ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/members" ),
                  aToken );

    return performJson( curl, aError );
}


bool COLLAB_REST::RemoveMember( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId, long long aUserId,
                                ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl,
                  wxString::Format( wxS( "%s/api/projects/%s/members/%lld" ), aServerUrl,
                                    aProjectId, aUserId ),
                  aToken );

    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "DELETE" );

    return performOk( curl, aError );
}


bool COLLAB_REST::RevokeInvite( const wxString& aServerUrl, const wxString& aToken,
                                const wxString& aProjectId, long long aInviteId,
                                ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl,
                  wxString::Format( wxS( "%s/api/projects/%s/invites/%lld" ), aServerUrl,
                                    aProjectId, aInviteId ),
                  aToken );

    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "DELETE" );

    return performOk( curl, aError );
}


bool COLLAB_REST::SetMemberRole( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId, long long aUserId,
                                 const wxString& aRole,
                                 ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl,
                  wxString::Format( wxS( "%s/api/projects/%s/members/%lld" ), aServerUrl,
                                    aProjectId, aUserId ),
                  aToken );

    nlohmann::json body = { { "role", aRole.ToStdString( wxConvUTF8 ) } };

    setJsonBody( curl, body );
    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "PATCH" );

    return performOk( curl, aError );
}


bool COLLAB_REST::SetInviteRole( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aProjectId, long long aInviteId,
                                 const wxString& aRole,
                                 ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl,
                  wxString::Format( wxS( "%s/api/projects/%s/invites/%lld" ), aServerUrl,
                                    aProjectId, aInviteId ),
                  aToken );

    nlohmann::json body = { { "role", aRole.ToStdString( wxConvUTF8 ) } };

    setJsonBody( curl, body );
    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "PATCH" );

    return performOk( curl, aError );
}


std::optional<nlohmann::json> COLLAB_REST::ListShareLinks( const wxString& aServerUrl,
                                                           const wxString& aToken,
                                                           const wxString& aProjectId,
                                                           ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/links" ),
                  aToken );

    return performJson( curl, aError );
}


bool COLLAB_REST::RevokeShareLink( const wxString& aServerUrl, const wxString& aToken,
                                   const wxString& aLinkToken,
                                   ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/links/" ) + aLinkToken, aToken );

    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "DELETE" );

    return performOk( curl, aError );
}


std::optional<nlohmann::json> COLLAB_REST::CreateDoc( const wxString& aServerUrl,
                                                      const wxString& aToken,
                                                      const wxString& aProjectId,
                                                      const wxString& aPath )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/docs" ),
                  aToken );

    nlohmann::json body = { { "path", aPath.ToStdString( wxConvUTF8 ) } };
    setJsonBody( curl, body );

    return performJson( curl );
}


std::string COLLAB_REST::FetchDocContent( const wxString& aServerUrl, const wxString& aToken,
                                          const wxString& aDocId )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/docs/" ) + aDocId + wxS( "/content" ), aToken );

    int code = curl.Perform();

    if( code != CURLE_OK || curl.GetResponseStatusCode() != 200 )
        return std::string();

    return curl.GetBuffer();
}


bool COLLAB_REST::UploadPreview( const wxString& aServerUrl, const wxString& aToken,
                                 const wxString& aDocId, long long aSeq, bool aFit,
                                 const std::string& aSvg )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl,
                  wxString::Format( wxS( "%s/api/docs/%s/preview?seq=%lld&fit=%s" ), aServerUrl,
                                    aDocId, aSeq, aFit ? wxS( "true" ) : wxS( "false" ) ),
                  aToken );

    curl.SetHeader( "Content-Type", "image/svg+xml" );

    curl_easy_setopt( curl.GetCurl(), CURLOPT_POSTFIELDSIZE_LARGE,
                      static_cast<curl_off_t>( aSvg.size() ) );
    curl_easy_setopt( curl.GetCurl(), CURLOPT_COPYPOSTFIELDS, aSvg.data() );

    return performJson( curl ).has_value();
}


std::optional<nlohmann::json> COLLAB_REST::ListCheckpoints( const wxString& aServerUrl,
                                                             const wxString& aToken,
                                                             const wxString& aProjectId )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/checkpoints" ),
                  aToken );

    return performJson( curl );
}


std::optional<nlohmann::json> COLLAB_REST::CreateCheckpoint( const wxString& aServerUrl,
                                                             const wxString& aToken,
                                                             const wxString& aProjectId,
                                                             const wxString& aName )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/checkpoints" ),
                  aToken );

    nlohmann::json body = { { "name", aName.ToStdString( wxConvUTF8 ) } };
    setJsonBody( curl, body );

    return performJson( curl );
}


std::optional<nlohmann::json> COLLAB_REST::RestoreCheckpoint( const wxString& aServerUrl,
                                                              const wxString& aToken,
                                                              const wxString& aProjectId,
                                                              const wxString& aName )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/projects/" ) + aProjectId + wxS( "/restore" ),
                  aToken );

    nlohmann::json body = { { "name", aName.ToStdString( wxConvUTF8 ) } };
    setJsonBody( curl, body );

    return performJson( curl );
}


std::optional<nlohmann::json> COLLAB_REST::ListComments( const wxString& aServerUrl,
                                                          const wxString& aToken,
                                                          const wxString& aDocId )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/docs/" ) + aDocId + wxS( "/comments" ), aToken );

    return performJson( curl );
}


std::optional<nlohmann::json> COLLAB_REST::CreateComment( const wxString& aServerUrl,
                                                          const wxString& aToken,
                                                          const wxString& aDocId,
                                                          const wxString& aBody, long long aX,
                                                          long long aY, long long aParentId )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/docs/" ) + aDocId + wxS( "/comments" ), aToken );

    nlohmann::json body = { { "body", aBody.ToStdString( wxConvUTF8 ) } };

    if( aParentId >= 0 )
        body[ "parentId" ] = aParentId;
    else
    {
        body[ "x" ] = aX;
        body[ "y" ] = aY;
    }

    setJsonBody( curl, body );

    return performJson( curl );
}


bool COLLAB_REST::SetCommentResolved( const wxString& aServerUrl, const wxString& aToken,
                                      long long aCommentId, bool aResolved )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl,
                  aServerUrl + wxS( "/api/comments/" )
                          + wxString::Format( wxS( "%lld" ), aCommentId ),
                  aToken );

    nlohmann::json body = { { "resolved", aResolved } };
    setJsonBody( curl, body );
    curl_easy_setopt( curl.GetCurl(), CURLOPT_CUSTOMREQUEST, "PATCH" );

    return performJson( curl ).has_value();
}


std::optional<nlohmann::json> COLLAB_REST::Me( const wxString& aServerUrl, const wxString& aToken,
                                               ERROR_INFO* aError )
{
    KICAD_CURL_EASY curl;
    setupRequest( curl, aServerUrl + wxS( "/api/me" ), aToken );

    return performJson( curl, aError );
}
