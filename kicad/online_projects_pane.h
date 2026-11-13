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
#include <map>
#include <vector>

#include <collab/collab_auth.h>
#include <collab/collab_rest.h>
#include <memory>
#include <nlohmann/json.hpp>
#include <wx/panel.h>
#include <wx/longlong.h>
#include <wx/timer.h>

class KICAD_MANAGER_FRAME;
class ONLINE_PROJECT_STORE;
class wxButton;
class wxCloseEvent;
class wxDataViewEvent;
class wxDataViewListCtrl;
class wxSearchCtrl;
class wxStaticText;
class wxKeyEvent;
class BITMAP_BUTTON;

/**
 * The "online files" home, docked in the project manager next to the editors so the
 * cloud is always one glance away: the account, the project open here and whether it
 * syncs, and every online project the signed-in user owns or was invited to, with open /
 * share / create / star / copy / delete, and the Trash that deleted projects can be
 * restored from.
 */
class ONLINE_PROJECTS_PANE : public wxPanel
{
public:
    ONLINE_PROJECTS_PANE( KICAD_MANAGER_FRAME* aParent );
    ~ONLINE_PROJECTS_PANE() override;

    /// Run the join-from-link flow.  Empty prompts for the link; otherwise the
    /// given share link / token is used directly (deep link, menu, etc.).
    /// With aOpenWithoutAsking the joined project is opened straight away.
    /// When signed out, sign-in is started first and the join continues once
    /// it succeeds.
    void JoinWithLink( const wxString& aLinkOrToken, bool aOpenWithoutAsking = false );

    /// The project manager opened or closed a project: redo the "this project" card and
    /// what New can publish.
    void OnProjectChanged();

    /// Reload the list and the sign-in state, unless something is running.  Used after the
    /// File menu's own sign-in, publish and sync commands.
    void RefreshList();

    /// Reload when the list is older than a minute (the window came back to the front).
    void RefreshIfStale();

    /// Put the keyboard in the filter box.
    void FocusSearch();

    /// False while a local copy is being written or a project uploaded: quitting then
    /// would leave a folder that nothing knows to be the project's copy.
    bool CanClose() const { return !m_downloading && !m_publishing; }

    /// Start the upload of the project open in the project manager (signing in first).
    void PublishCurrentProject() { publishCurrentProject(); }

private:
    ///< A blocking job for the worker thread; gets the server URL and bearer token, and
    ///< says in aError why it failed.
    using ASYNC_WORK = std::function<bool( const wxString& aServer, const wxString& aToken,
                                           COLLAB_REST::ERROR_INFO& aError )>;

    ///< Runs on the UI thread after the job, unless the dialog is gone by then.
    using ASYNC_DONE = std::function<void( bool aOk, const COLLAB_REST::ERROR_INFO& aError )>;

    ///< Reload the list on show: the projects, or the Trash.  Works signed out as well,
    ///< which is how the dialog notices a sign-in that happened elsewhere.
    void refresh();

    ///< Take fetched /me + listing results (UI thread).  aMeOk / aListingOk are false
    ///< when that request failed; aListingError then says why.
    void populate( const nlohmann::json& aMe, bool aMeOk, const nlohmann::json& aListing,
                   bool aListingOk, const COLLAB_REST::ERROR_INFO& aListingError );

    ///< Rebuild the visible rows from m_allProjects and the search text, keeping
    ///< (or, with aSelectProjectId, moving) the selection.
    void applyFilter( const wxString& aSelectProjectId = wxEmptyString );

    void updateSignInState();

    ///< Enable/label the action buttons for the current selection and busy state.
    void updateControls();

    ///< The bottom status line: busy text, a one-off notice, or the list state.
    void updateStatus();

    ///< Show a one-off message in the status line (empty clears it).  It stays through
    ///< a reload of the list and goes with the next thing the user does.  With
    ///< aUndoProjectId it comes with an Undo button that restores that deleted project.
    void setNotice( const wxString& aNotice, const wxString& aUndoProjectId = wxEmptyString,
                    const wxString& aUndoProjectName = wxEmptyString );

    ///< Forget the notice and the Undo that came with it, without redrawing anything.
    void clearNotice();

    ///< Empty the search box and show every project again.
    void clearFilter();

    ///< Tell the user that aWhat failed, and why.
    void showFailure( const wxString& aWhat, const wxString& aTitle,
                      const COLLAB_REST::ERROR_INFO& aError );

    ///< Switch between the projects and the Trash, and reload.
    void showTrash( bool aShowTrash );

    ///< Columns, buttons and wording for the list on show (projects or Trash).
    void applyViewMode();

    void beginBusy( const wxString& aStatus );
    void endBusy();

    /**
     * Run aWork on the collab worker thread with the dialog marked busy, then
     * aDone on the UI thread.  Capture std::string / plain values only: the
     * closures are copied across threads.
     */
    void runAsync( const wxString& aStatus, ASYNC_WORK aWork, ASYNC_DONE aDone );

    ///< Start the browser sign-in; aThen runs (UI thread) once it succeeded.  Does
    ///< nothing while a sign-in is already pending.
    void startSignIn( std::function<void()> aThen );

    ///< Give up on a pending browser sign-in, so that it can be started afresh.
    void cancelSignIn();

    ///< Run aThen now when signed in, else after a sign-in that is started for it.
    void whenSignedIn( std::function<void()> aThen );

    ///< Work out whether the project open in the project manager can be published
    ///< (m_publishBlocked), and say so on the New Online Project button.
    void updatePublishable();

    ///< Publish the project open in the project manager, then show it in the list.
    ///< Signs in first when needed.
    void publishCurrentProject();

    ///< The upload itself, off the UI thread, and linking this folder to the result.
    void uploadCurrentProject();

    /// New > Publish a Folder: a project on disk that is not the one open.
    void publishFolder();

    /// Zip and upload the project in @a aProjectPath, then make that folder its local copy.
    void uploadProject( const wxString& aProjectPath, const wxString& aProjectName,
                        const wxString& aProFile );

    ///< Ask for a name, create an empty online project and open it.
    void newBlankProject();
    void createBlankProject( const wxString& aName );

    ///< Take a project back out of the Trash (the Undo of a delete, and Restore).
    void restoreProject( const wxString& aProjectId, const wxString& aName );

    ///< Destroy the selected project in the Trash for good, after asking.
    void purgeSelected();

    ///< Claim a parsed share-link token and offer to open the joined project.
    void claimLink( const wxString& aLinkToken, bool aOpenWithoutAsking );

    ///< The listing row currently selected, or nullptr.
    const nlohmann::json* selectedProject() const;

    ///< The projectId of the selected row, or empty.
    wxString selectedProjectId() const;

    ///< True when the signed-in user owns the selected project.
    bool ownsSelected() const;

    void onSignInOut( wxCommandEvent& aEvent );
    void onRefresh( wxCommandEvent& aEvent );
    void onOpen( wxCommandEvent& aEvent );
    void onOpenInFolder( wxCommandEvent& aEvent );
    void onShare( wxCommandEvent& aEvent );
    void onNewProject( wxCommandEvent& aEvent );
    void onJoinLink( wxCommandEvent& aEvent );
    void onToggleTrash( wxCommandEvent& aEvent );
    void onUndo( wxCommandEvent& aEvent );
    void onRename( wxCommandEvent& aEvent );
    void onDetails( wxCommandEvent& aEvent );
    void onToggleStar( wxCommandEvent& aEvent );
    void onMakeCopy( wxCommandEvent& aEvent );
    void onOpenInBrowser( wxCommandEvent& aEvent );
    void onTogglePublic( wxCommandEvent& aEvent );
    void onDelete( wxCommandEvent& aEvent );
    void onCopyWebLink( wxCommandEvent& aEvent );
    void onSearchText( wxCommandEvent& aEvent );
    void onItemActivated( wxDataViewEvent& aEvent );
    void onSelectionChanged( wxDataViewEvent& aEvent );
    void onContextMenu( wxDataViewEvent& aEvent );
    void onMore( wxCommandEvent& aEvent );
    void onProjectCardAction( wxCommandEvent& aEvent );
    void onProjectCardShare( wxCommandEvent& aEvent );

    ///< Enter opens, Delete deletes/leaves, F2 renames, F5 refreshes, Ctrl/Cmd+F focuses
    ///< the search box and Escape clears a filter.
    void onCharHook( wxKeyEvent& aEvt );

    ///< The menu of everything that can be done with the selected row, at the pointer
    ///< (right-click) or under the More button.
    void showProjectMenu( wxWindow* aBelow );

    ///< Share sheet for one project.
    void shareProject( const nlohmann::json& aProject, bool aOwner );

    ///< Open a .kicad_pro that is on disk already, in the project manager.
    void openLocalCopy( const wxString& aProFile );

    ///< Redo the "this project" card: the project open in the project manager, whether it
    ///< is online, and how its live session is doing.
    ///< aReadLink reads the folder's link to the server again; the timer that keeps the
    ///< session state fresh does without.
    void updateProjectCard( bool aReadLink = true );

    ///< Fit the columns to the pane's width: the name takes what is left over, and the
    ///< columns that do not fit are hidden (the line under the list says what they would).
    void fitColumns();

    ///< The line under the list: owner, role, visibility and age of the selected row.
    void updateDetails();

    ///< The listing row of the project open in the project manager, or nullptr.
    const nlohmann::json* currentProjectRow() const;

    ///< Give up our own membership of the selected (not owned) project.
    void leaveSelected();

    /**
     * Open the listing row: reuse its local copy, or download one and note it
     * for opening.  The copy goes under <projects>/Cloud/<name> unless
     * aChooseFolder asks the user where to put it.  Never writes into a folder
     * that holds anything other than a copy of this project.
     */
    void openProject( const nlohmann::json& aProject, bool aChooseFolder = false );

private:
    KICAD_MANAGER_FRAME* m_frame;

    ///< Cleared by the destructor so async completions can tell the dialog is
    ///< gone before touching it.
    std::shared_ptr<bool> m_alive;

    ///< Replaced by a fresh one to abandon a pending sign-in.
    std::unique_ptr<COLLAB_AUTH> m_auth;

    wxStaticText*         m_signedInLabel;   ///< the account, bold
    wxStaticText*         m_serverLabel;     ///< the server it is on, grey
    wxButton*             m_signInButton;
    BITMAP_BUTTON*        m_refreshButton;
    BITMAP_BUTTON*        m_trashButton;

    wxPanel*              m_projectCard;     ///< the project open in the project manager
    wxStaticText*         m_projectName;
    wxStaticText*         m_projectState;
    wxButton*             m_projectShare;
    wxButton*             m_projectAction;   ///< Publish Online / Sync Settings
    wxString              m_cardProjectId;   ///< online id of the open project, or empty
    wxString              m_cardProjectFile; ///< the .kicad_pro m_cardProjectId was read for
    wxTimer               m_liveTimer;       ///< keeps the session state on the card fresh
    wxLongLong            m_lastRefresh;     ///< wall clock of the last listing, ms
    wxStaticText*         m_listHeading;
    wxSearchCtrl*         m_search;
    wxDataViewListCtrl*   m_list;
    ONLINE_PROJECT_STORE* m_store;        ///< the model behind m_list; owned by it
    wxButton*             m_openButton;
    wxButton*             m_shareButton;
    wxButton*             m_moreButton;
    wxButton*             m_newButton;
    wxButton*             m_joinButton;
    wxStaticText*         m_detailLabel;
    wxStaticText*         m_statusLabel;
    wxButton*             m_undoButton;

    std::vector<nlohmann::json> m_allProjects; ///< everything the server listed
    std::vector<nlohmann::json> m_projects;    ///< rows behind m_list, by model row
    std::map<wxString, wxString> m_localCopies; ///< projectId -> local .kicad_pro
    long long                   m_myUserId;
    wxString                    m_myLogin;

    ///< Why the project open in the project manager cannot be published, or empty.
    wxString                    m_publishBlocked;

    bool                        m_signedIn;     ///< a bearer token is stored
    bool                        m_loaded;       ///< a listing has been fetched
    bool                        m_loadFailed;   ///< the last fetch failed
    COLLAB_REST::ERROR_INFO     m_loadError;    ///< ... and why
    bool                        m_showTrash;    ///< the list shows the Trash
    bool                        m_populating;   ///< the rows are being rebuilt
    int                         m_busy;         ///< async jobs in flight
    bool                        m_signingIn;    ///< a browser sign-in is pending
    bool                        m_downloading;  ///< a local copy is being written
    bool                        m_publishing;   ///< the current project is being uploaded
    std::function<void()>       m_afterSignIn;  ///< continues once signed in
    int                         m_refreshGeneration; ///< drops stale listings
    wxString                    m_busyText;
    wxString                    m_notice;
    wxString                    m_undoProjectId;   ///< what the notice's Undo restores
    wxString                    m_undoProjectName;
    wxString                    m_selectAfterRefresh; ///< projectId to re-select
};
