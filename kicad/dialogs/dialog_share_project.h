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

#include <atomic>
#include <functional>
#include <vector>

#include <collab/collab_rest.h>
#include <dialog_shim.h>
#include <memory>
#include <nlohmann/json.hpp>
#include <wx/timer.h>

class wxBoxSizer;
class wxButton;
class wxCheckBox;
class wxChoice;
class wxDataViewEvent;
class wxDataViewListCtrl;
class wxListBox;
class wxStaticBoxSizer;
class wxStaticText;
class wxTextCtrl;

/**
 * Figma-style share sheet for one online project: mint/copy/revoke share links,
 * invite people by GitHub username or email (with typeahead search, like adding
 * a GitHub collaborator), see, re-role or revoke who has access, hand the project
 * to a new owner and list it publicly.  Members who are not the owner get it
 * read-only: they see who has access, nothing more.
 */
class DIALOG_SHARE_PROJECT : public DIALOG_SHIM
{
public:
    /**
     * @param aCanManage whether the signed-in user is expected to be the owner; only
     *                   decides how the sheet looks until the server has answered.
     * @param aPublic whether the project is listed publicly at the moment.
     */
    DIALOG_SHARE_PROJECT( wxWindow* aParent, const wxString& aProjectId,
                          const wxString& aProjectName, bool aCanManage = true,
                          bool aPublic = false );
    ~DIALOG_SHARE_PROJECT() override;

    /// True once the owner or the public listing of the project was changed here, so
    /// whatever lists the project should be reloaded.
    bool ProjectChanged() const { return m_projectChanged; }

    /// A server role name ("owner", "editor", "commenter", "viewer") the way the user interface words it.
    static wxString RoleLabel( const wxString& aRole );

private:
    ///< A blocking job for the worker thread; gets the server URL and bearer token, and
    ///< says in aError why it failed.
    using ASYNC_WORK = std::function<bool( const wxString& aServer, const wxString& aToken,
                                           COLLAB_REST::ERROR_INFO& aError )>;

    ///< Runs on the UI thread after the job, unless the dialog is gone by then.
    using ASYNC_DONE = std::function<void( bool aOk, const COLLAB_REST::ERROR_INFO& aError )>;

    ///< Re-fetch members, pending invites and (for the owner) share links.
    void refreshMembers();

    ///< Fill the lists from the fetched results (UI thread).
    void populate( const nlohmann::json& aMembers, bool aMembersOk, const nlohmann::json& aLinks,
                   bool aLinksOk );

    void populateLinks();

    ///< Show or hide the owner-only controls.
    void applyManageMode();

    ///< Enable the per-row controls for the current selection and busy state.
    void updateControls();

    ///< Make the role choice show the selected person's role.
    void syncMemberRoleChoice();

    ///< Tell the user that aWhat failed, and why.
    void showFailure( const wxString& aWhat, const wxString& aTitle,
                      const COLLAB_REST::ERROR_INFO& aError );

    void setStatus( const wxString& aStatus );

    ///< Show the busy text, the loading text or the last status, in that order.
    void updateStatus();

    void beginBusy( const wxString& aStatus );
    void endBusy();

    /**
     * Run aWork on the collab worker thread with the dialog marked busy, then
     * aDone on the UI thread.  Capture std::string / plain values only: the
     * closures are copied across threads.
     */
    void runAsync( const wxString& aStatus, ASYNC_WORK aWork, ASYNC_DONE aDone );

    ///< The m_memberRows entry behind the selected row, or nullptr.
    const nlohmann::json* selectedMember() const;

    ///< The m_linkRows entry behind the selected row, or nullptr.
    const nlohmann::json* selectedLink() const;

    void onCreateLink( wxCommandEvent& aEvent );
    void onCopyLink( wxCommandEvent& aEvent );
    void onRevokeLink( wxCommandEvent& aEvent );
    void onInviteText( wxCommandEvent& aEvent );
    void onSearchTimer( wxTimerEvent& aEvent );
    ///< Render one search response into the results list (UI thread).
    void showSearchResults( const nlohmann::json& aUsers );
    void onResultSelected( wxCommandEvent& aEvent );
    void onInvite( wxCommandEvent& aEvent );
    void onMemberRole( wxCommandEvent& aEvent );
    void onRemove( wxCommandEvent& aEvent );
    void onMakeOwner( wxCommandEvent& aEvent );
    void onPublic( wxCommandEvent& aEvent );
    void onSelectionChanged( wxDataViewEvent& aEvent );

private:
    wxString m_projectId;

    wxBoxSizer*         m_mainSizer;
    wxStaticText*       m_readOnlyNote;
    wxStaticBoxSizer*   m_linkBox;
    wxChoice*           m_linkRole;
    wxChoice*           m_linkExpiry;
    wxButton*           m_createLinkButton;
    wxDataViewListCtrl* m_links;
    wxButton*           m_copyLinkButton;
    wxButton*           m_revokeLinkButton;
    wxStaticBoxSizer*   m_inviteBox;
    wxTextCtrl*         m_inviteText;
    wxListBox*          m_results;
    wxChoice*           m_inviteRole;
    wxButton*           m_inviteButton;
    wxStaticText*       m_inviteStatus;
    wxDataViewListCtrl* m_members;
    wxStaticText*       m_memberRoleLabel;
    wxChoice*           m_memberRole;
    wxButton*           m_removeButton;
    wxButton*           m_makeOwnerButton;
    wxCheckBox*         m_publicCheck;
    wxStaticText*       m_statusLabel;

    wxTimer                     m_searchTimer;

    std::shared_ptr<bool> m_alive;      ///< async-completion liveness guard

    ///< Drops stale search results; shared with the worker so that it can skip a
    ///< search that was superseded before its turn came.
    std::shared_ptr<std::atomic<int>> m_searchGeneration;
    int            m_refreshGeneration = 0; ///< drops stale member listings
    int            m_busy = 0;             ///< changes being sent to the server
    int            m_refreshing = 0;       ///< member listings being fetched
    bool           m_canManage;            ///< the signed-in user owns the project
    bool           m_public;               ///< the project is listed publicly
    bool           m_projectChanged;       ///< see ProjectChanged()
    wxString       m_busyText;             ///< status line while busy
    wxString       m_statusText;           ///< status line otherwise
    std::vector<nlohmann::json> m_resultRows;   ///< rows behind m_results
    std::vector<nlohmann::json> m_memberRows;   ///< rows behind m_members
    std::vector<nlohmann::json> m_linkRows;     ///< rows behind m_links
    bool                        m_suppressSearch;
};
