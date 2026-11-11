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

#include <memory>
#include <nlohmann/json.hpp>
#include <wx/panel.h>

class EDA_BASE_FRAME;
class wxDataViewListCtrl;
class wxButton;

/**
 * Sidebar pane with the shared project's version history: the versions somebody saved and
 * the ones the server kept by itself before a restore or a merge, newest first, with "save
 * version" and restore.  A restore keeps the project as it is now as a version of its own,
 * resets the documents on the server, and every live editor reconciles automatically.
 * The list follows the server's "versions" notice, so it never needs a manual refresh.
 * Scrubbing through single edits and working with branches happen in the web editor, which
 * the panel opens on this project.
 *
 * The panel is dormant (empty list, disabled buttons) until a collaboration
 * session hands it a project id via SetProject().
 */
class COLLAB_HISTORY_PANEL : public wxPanel
{
public:
    COLLAB_HISTORY_PANEL( wxWindow* aParent, EDA_BASE_FRAME* aFrame );
    ~COLLAB_HISTORY_PANEL() override;

    /// Bind to a project (empty id returns the panel to its dormant state).
    void SetProject( const wxString& aProjectId );

    /// Re-fetch the version list (off the UI thread).
    void RefreshHistory();

private:
    void populate( const nlohmann::json& aListing );
    void onCheckpoint();
    void onRestore();
    void onOpenTimeline();

    /// Index into m_rowIds / m_rowNames of the selected row, or -1.
    int selectedRow() const;

private:
    EDA_BASE_FRAME* m_frame;
    wxString        m_projectId;

    wxDataViewListCtrl* m_list;
    wxButton*           m_checkpointBtn;
    wxButton*           m_restoreBtn;
    wxButton*           m_timelineBtn;

    std::vector<wxString> m_rowIds;
    std::vector<wxString> m_rowNames;

    ///< A fetch is on its way; notices that arrive meanwhile ask for one more after it.
    bool m_fetching = false;
    bool m_fetchAgain = false;

    ///< Cleared by the destructor so async completions can tell the panel is gone.
    std::shared_ptr<bool> m_alive;
};
