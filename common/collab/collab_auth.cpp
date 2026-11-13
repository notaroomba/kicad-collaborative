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

#include <collab/collab_auth.h>
#include <wx/intl.h>

#include <kicad_curl/kicad_curl_easy.h>
#include <nlohmann/json.hpp>
#include <oauth/oauth_loopback_server.h>
#include <oauth/oauth_pkce.h>
#include <oauth/secure_token_store.h>
#include <paths.h>

#include <wx/datetime.h>
#include <wx/file.h>
#include <wx/filename.h>
#include <wx/log.h>
#include <wx/uri.h>
#include <wx/utils.h>


#ifdef __WXOSX__
/**
 * Keeps the sign-in in a file only the user can read instead of the login keychain.
 *
 * A keychain item is tied to the code signature of the application that wrote it.  Junction
 * is signed ad hoc, so every build has a different signature and macOS asks for the keychain
 * password again after each update, whatever was answered before ("Always Allow" included).
 */
// ponytail: plain file with mode 0600, the same protection gh and npm give their tokens;
// go back to PLATFORM_SECRET_BACKEND once the application is signed with a Developer ID.
class FILE_SECRET_BACKEND : public OAUTH_SECRET_BACKEND
{
public:
    bool StoreSecret( const wxString& aService, const wxString& aKey,
                      const wxString& aSecret ) override
    {
        nlohmann::json all = read();
        all[id( aService, aKey )] = aSecret.ToStdString( wxConvUTF8 );
        return write( all );
    }

    bool GetSecret( const wxString& aService, const wxString& aKey,
                    wxString& aSecret ) const override
    {
        nlohmann::json all = read();
        auto           it = all.find( id( aService, aKey ) );

        if( it == all.end() || !it->is_string() )
            return false;

        aSecret = wxString::FromUTF8( it->get<std::string>() );
        return true;
    }

    bool DeleteSecret( const wxString& aService, const wxString& aKey ) override
    {
        nlohmann::json all = read();
        return all.erase( id( aService, aKey ) ) == 0 || write( all );
    }

private:
    static std::string id( const wxString& aService, const wxString& aKey )
    {
        return ( aService + wxS( "/" ) + aKey ).ToStdString( wxConvUTF8 );
    }

    static wxString path()
    {
        return wxFileName( PATHS::GetUserSettingsPath(), wxS( "junction-session.json" ) ).GetFullPath();
    }

    static nlohmann::json read()
    {
        wxString text;
        wxFile   file;

        if( wxFileExists( path() ) && file.Open( path() ) && file.ReadAll( &text ) )
        {
            nlohmann::json parsed = nlohmann::json::parse( text.ToStdString( wxConvUTF8 ), nullptr, false );

            if( parsed.is_object() )
                return parsed;
        }

        return nlohmann::json::object();
    }

    static bool write( const nlohmann::json& aAll )
    {
        wxFile file;

        // An existing file keeps the mode it was created with, which is this one.
        return file.Create( path(), true, wxS_IRUSR | wxS_IWUSR )
               && file.Write( wxString::FromUTF8( aAll.dump() ) );
    }
};
#endif


/// Where the sign-in for a collaboration server is kept on this platform.
static SECURE_TOKEN_STORE tokenStore()
{
#ifdef __WXOSX__
    return SECURE_TOKEN_STORE( std::make_unique<FILE_SECRET_BACKEND>() );
#else
    return SECURE_TOKEN_STORE();
#endif
}


COLLAB_AUTH::COLLAB_AUTH()
{
    Bind( EVT_OAUTH_LOOPBACK_RESULT, &COLLAB_AUTH::onLoopbackResult, this );
}


COLLAB_AUTH::~COLLAB_AUTH()
{
    Unbind( EVT_OAUTH_LOOPBACK_RESULT, &COLLAB_AUTH::onLoopbackResult, this );
}


wxString COLLAB_AUTH::accountIdFor( const wxString& aServerUrl )
{
    wxURI uri( aServerUrl );
    wxString server = uri.GetServer();
    return server.IsEmpty() ? aServerUrl : server;
}


bool COLLAB_AUTH::SignIn( const wxString& aServerUrl, COMPLETION aCompletion, wxString& aError )
{
    if( m_loopback )
    {
        aError = _( "A sign-in is already in progress." );
        return false;
    }

    m_serverUrl = aServerUrl;
    m_serverUrl.Trim().Trim( false );

    while( m_serverUrl.EndsWith( wxS( "/" ) ) )
        m_serverUrl.RemoveLast();

    m_completion = std::move( aCompletion );

    m_session.authorization_endpoint = m_serverUrl + wxS( "/auth/desktop/authorize" );
    m_session.client_id = wxS( "kicad" );
    m_session.scope = wxS( "collab" );
    m_session.state = OAUTH_PKCE::GenerateState();
    m_session.code_verifier = OAUTH_PKCE::GenerateCodeVerifier();

    m_loopback = std::make_unique<OAUTH_LOOPBACK_SERVER>( this, wxS( "/callback" ),
                                                          m_session.state );

    if( !m_loopback->Start() )
    {
        m_loopback.reset();
        aError = _( "Unable to start the local sign-in callback listener." );
        return false;
    }

    m_session.redirect_uri = m_loopback->GetRedirectUri();

    if( !wxLaunchDefaultBrowser( m_session.BuildAuthorizationUrl(), wxBROWSER_NEW_WINDOW ) )
    {
        m_loopback.reset();
        aError = _( "Unable to open the system browser for sign-in." );
        return false;
    }

    return true;
}


void COLLAB_AUTH::onLoopbackResult( wxCommandEvent& aEvent )
{
    m_loopback.reset();

    COMPLETION completion = std::move( m_completion );
    m_completion = nullptr;

    if( !aEvent.GetInt() )
    {
        if( completion )
            completion( false, _( "Sign-in was cancelled or timed out." ) );

        return;
    }

    // Exchange the one-time code for a bearer token.
    nlohmann::json body = {
        { "grant_type", "authorization_code" },
        { "code", aEvent.GetString().ToStdString( wxConvUTF8 ) },
        { "code_verifier", m_session.code_verifier.ToStdString( wxConvUTF8 ) },
        { "redirect_uri", m_session.redirect_uri.ToStdString( wxConvUTF8 ) },
    };

    KICAD_CURL_EASY curl;
    curl.SetURL( ( m_serverUrl + wxS( "/auth/desktop/token" ) ).ToStdString( wxConvUTF8 ) );
    curl.SetHeader( "Content-Type", "application/json" );
    curl.SetHeader( "Accept", "application/json" );
    curl.SetPostFields( body.dump() );
    curl.SetTimeout( 30 );

    int rc = curl.Perform();

    wxString token;
    long long expiresIn = 0;

    if( rc == 0 && curl.GetResponseStatusCode() == 200 )
    {
        try
        {
            nlohmann::json response = nlohmann::json::parse( curl.GetBuffer() );
            token = wxString::FromUTF8( response.value( "access_token", "" ) );
            expiresIn = response.value( "expires_in", 0LL );
        }
        catch( const std::exception& e )
        {
            wxLogTrace( wxS( "COLLAB" ), wxS( "token response parse error: %s" ), e.what() );
        }
    }

    if( token.IsEmpty() )
    {
        if( completion )
            completion( false, _( "The collaboration server rejected the sign-in." ) );

        return;
    }

    OAUTH_TOKEN_SET tokens;
    tokens.access_token = token;
    tokens.token_type = wxS( "bearer" );
    tokens.expires_at = wxDateTime::Now().GetTicks() + expiresIn;

    SECURE_TOKEN_STORE store = tokenStore();
    store.StoreTokens( ProviderId(), accountIdFor( m_serverUrl ), tokens );

    if( completion )
        completion( true, token );
}


wxString COLLAB_AUTH::StoredToken( const wxString& aServerUrl )
{
    // Test/CI hook: a token supplied via the environment bypasses the keychain
    // (and the browser sign-in), so two instances on one machine can act as
    // different users against a local server.
    wxString envToken;

    if( wxGetEnv( wxS( "KICAD_COLLAB_TOKEN" ), &envToken ) && !envToken.IsEmpty() )
        return envToken;

    SECURE_TOKEN_STORE store = tokenStore();

    auto usable = []( const OAUTH_TOKEN_SET& aTokens )
    {
        // Leave ~1 day of slack so we don't hand out a token that dies mid-session.
        return aTokens.expires_at == 0
               || aTokens.expires_at > wxDateTime::Now().GetTicks() + 24 * 3600;
    };

    if( std::optional<OAUTH_TOKEN_SET> tokens =
                store.LoadTokens( ProviderId(), accountIdFor( aServerUrl ) ) )
    {
        if( usable( *tokens ) )
            return tokens->access_token;
    }

    // The default server moved from its Railway host to kicad.notaroomba.dev —
    // same backend, same tokens.  A sign-in stored under the old host is adopted
    // under the new one so an update does not look like a sign-out.
    static const wxString legacyHosts[] = {
        wxS( "https://kicad-collab-production.up.railway.app" ),
    };

    if( accountIdFor( aServerUrl ) == wxS( "kicad.notaroomba.dev" ) )
    {
        for( const wxString& legacy : legacyHosts )
        {
            std::optional<OAUTH_TOKEN_SET> tokens =
                    store.LoadTokens( ProviderId(), accountIdFor( legacy ) );

            if( tokens && usable( *tokens ) )
            {
                store.StoreTokens( ProviderId(), accountIdFor( aServerUrl ), *tokens );
                return tokens->access_token;
            }
        }
    }

#ifndef __WXOSX__
    // Sign-ins made before the rename to Junction sit under the old name.  Not on macOS: reading
    // that keychain item is what raises the password prompt this store exists to avoid.
    if( std::optional<OAUTH_TOKEN_SET> tokens =
                store.LoadTokens( wxS( "kicad-collab" ), accountIdFor( aServerUrl ) ) )
    {
        if( usable( *tokens ) )
        {
            store.StoreTokens( ProviderId(), accountIdFor( aServerUrl ), *tokens );
            return tokens->access_token;
        }
    }
#endif

    return wxEmptyString;
}


void COLLAB_AUTH::ForgetToken( const wxString& aServerUrl )
{
    SECURE_TOKEN_STORE store = tokenStore();
    store.DeleteTokens( ProviderId(), accountIdFor( aServerUrl ) );
}
