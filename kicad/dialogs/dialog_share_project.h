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

#include <dialog_shim.h>
#include <nlohmann/json.hpp>
#include <wx/timer.h>

class wxButton;
class wxChoice;
class wxDataViewListCtrl;
class wxListBox;
class wxTextCtrl;

/**
 * Figma-style share sheet for one online project: mint/copy share links, invite
 * people by GitHub username or email (with typeahead search, like adding a GitHub
 * collaborator), and see or revoke who has access.
 */
class DIALOG_SHARE_PROJECT : public DIALOG_SHIM
{
public:
    DIALOG_SHARE_PROJECT( wxWindow* aParent, const wxString& aProjectId,
                          const wxString& aProjectName );

private:
    void refreshMembers();

    void onCreateLink( wxCommandEvent& aEvent );
    void onInviteText( wxCommandEvent& aEvent );
    void onSearchTimer( wxTimerEvent& aEvent );
    void onResultSelected( wxCommandEvent& aEvent );
    void onInvite( wxCommandEvent& aEvent );
    void onRemove( wxCommandEvent& aEvent );

private:
    wxString m_projectId;

    wxChoice*           m_linkRole;
    wxTextCtrl*         m_linkText;
    wxTextCtrl*         m_inviteText;
    wxListBox*          m_results;
    wxChoice*           m_inviteRole;
    wxButton*           m_inviteButton;
    wxDataViewListCtrl* m_members;
    wxButton*           m_removeButton;

    wxTimer                     m_searchTimer;
    std::vector<nlohmann::json> m_resultRows;   ///< rows behind m_results
    std::vector<nlohmann::json> m_memberRows;   ///< rows behind m_members
    bool                        m_suppressSearch;
};
