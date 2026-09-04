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

#include <vector>

#include <collab/collab_auth.h>
#include <dialog_shim.h>
#include <memory>
#include <nlohmann/json.hpp>

class KICAD_MANAGER_FRAME;
class wxButton;
class wxDataViewListCtrl;
class wxStaticText;

/**
 * The "online files" home: every cloud project the signed-in user owns or was
 * invited to, with open / share / upload / delete.  Reached from the project
 * manager's File menu.
 */
class DIALOG_ONLINE_PROJECTS : public DIALOG_SHIM
{
public:
    DIALOG_ONLINE_PROJECTS( KICAD_MANAGER_FRAME* aParent );
    ~DIALOG_ONLINE_PROJECTS() override;

    /// The .kicad_pro the user chose to open, or empty.  Valid after ShowModal().
    wxString GetProjectToOpen() const { return m_projectToOpen; }

    /// Run the join-from-link flow.  Empty prompts for the link; otherwise the
    /// given share link / token is used directly (deep link, menu, etc.).
    void JoinWithLink( const wxString& aLinkOrToken );

    /// Auto-run JoinWithLink once the dialog is shown (used by the deep link).
    void SetPendingJoinLink( const wxString& aLink ) { m_pendingJoinLink = aLink; }

private:
    void refresh();

    ///< Fill the list from fetched /me + /api/projects results (UI thread).
    void populate( const nlohmann::json& aMe, const nlohmann::json& aListing );

    void updateSignInState();

    ///< The listing row currently selected, or nullptr.
    const nlohmann::json* selectedProject() const;

    ///< True when the signed-in user owns the selected project.
    bool ownsSelected() const;

    void onSignInOut( wxCommandEvent& aEvent );
    void onRefresh( wxCommandEvent& aEvent );
    void onOpen( wxCommandEvent& aEvent );
    void onShare( wxCommandEvent& aEvent );
    void onUpload( wxCommandEvent& aEvent );
    void onJoinLink( wxCommandEvent& aEvent );
    wxString m_pendingJoinLink;
    void onRename( wxCommandEvent& aEvent );
    void onTogglePublic( wxCommandEvent& aEvent );
    void onDelete( wxCommandEvent& aEvent );
    void onItemActivated( wxDataViewEvent& aEvent );
    void onUpdateUI( wxUpdateUIEvent& aEvent );

    ///< Download (or reuse) a local copy of the listing row and note it for opening.
    void openProject( const nlohmann::json& aProject );

private:
    KICAD_MANAGER_FRAME* m_frame;

    ///< Cleared by the destructor so async completions can tell the dialog is
    ///< gone before touching it.
    std::shared_ptr<bool> m_alive;
    COLLAB_AUTH          m_auth;

    wxStaticText*        m_signedInLabel;
    wxButton*            m_signInButton;
    wxDataViewListCtrl*  m_list;
    wxButton*            m_openButton;
    wxButton*            m_shareButton;
    wxButton*            m_renameButton;
    wxButton*            m_publicButton;
    wxButton*            m_deleteButton;

    std::vector<nlohmann::json> m_projects;   ///< rows behind m_list, same order
    long long                   m_myUserId;
    wxString                    m_myLogin;
    wxString                    m_projectToOpen;
};
