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

#include <functional>
#include <memory>

#include <kicommon.h>
#include <oauth/oauth_session.h>
#include <wx/event.h>
#include <wx/string.h>

class OAUTH_LOOPBACK_SERVER;

/**
 * Browser-based sign-in for the KiCad collaboration server.
 *
 * The collab server brokers GitHub OAuth: KiCad only speaks PKCE to the
 * server's /auth/desktop endpoints and receives an opaque bearer token,
 * which is stored in the OS keychain via SECURE_TOKEN_STORE.
 */
class KICOMMON_API COLLAB_AUTH : public wxEvtHandler
{
public:
    /// Called on the UI thread; on success aTokenOrError is the bearer token.
    using COMPLETION = std::function<void( bool aSuccess, const wxString& aTokenOrError )>;

    COLLAB_AUTH();
    ~COLLAB_AUTH() override;

    /**
     * Start the interactive browser sign-in against aServerUrl.
     * Returns false (with aError set) if the flow could not be started.
     * At most one flow may be in flight per COLLAB_AUTH instance.
     */
    bool SignIn( const wxString& aServerUrl, COMPLETION aCompletion, wxString& aError );

    /// The stored bearer token for aServerUrl, or empty.
    static wxString StoredToken( const wxString& aServerUrl );

    static void ForgetToken( const wxString& aServerUrl );

    static wxString ProviderId() { return wxS( "kicad-collab" ); }

private:
    void onLoopbackResult( wxCommandEvent& aEvent );

    static wxString accountIdFor( const wxString& aServerUrl );

    wxString                               m_serverUrl;
    OAUTH_SESSION                          m_session;
    std::unique_ptr<OAUTH_LOOPBACK_SERVER> m_loopback;
    COMPLETION                             m_completion;
};
