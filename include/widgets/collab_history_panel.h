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
 * Sidebar pane with the shared project's version history: named checkpoints,
 * newest first, with "checkpoint now" and owner restore.  A restore resets
 * the documents on the server and every live editor reconciles automatically.
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

    /// Re-fetch the checkpoint list (off the UI thread).
    void RefreshHistory();

private:
    void populate( const nlohmann::json& aListing );
    void onCheckpoint();
    void onRestore();

    wxString selectedName() const;

private:
    EDA_BASE_FRAME* m_frame;
    wxString        m_projectId;

    wxDataViewListCtrl* m_list;
    wxButton*           m_checkpointBtn;
    wxButton*           m_restoreBtn;
    wxButton*           m_refreshBtn;

    std::vector<wxString> m_rowNames;

    ///< Cleared by the destructor so async completions can tell the panel is gone.
    std::shared_ptr<bool> m_alive;
};
