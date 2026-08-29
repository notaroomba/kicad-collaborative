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
#include <nlohmann/json.hpp>
#include <wx/dialog.h>

class wxDataViewListCtrl;
class wxTextCtrl;
class wxButton;

/**
 * The shared project's comment threads: browse, reply, resolve, and add a
 * comment at a board position.  The dialog is a *view* over the tool's
 * comment state — mutations go through REST (off the UI thread via the
 * session worker) and come back as live `comment` broadcasts, on which the
 * tool calls Reload().
 */
class DIALOG_COLLAB_COMMENTS : public wxDialog
{
public:
    /**
     * @param aComments   the tool's comment array (REST shape), borrowed.
     * @param aNewAnchor  board position (nm) a "New Comment" should pin to.
     * @param aPost       callback( body, parentId or -1 ) — posts off-thread.
     * @param aResolve    callback( rootId, resolved ).
     */
    DIALOG_COLLAB_COMMENTS( wxWindow* aParent, const nlohmann::json* aComments,
                         const VECTOR2I& aNewAnchor,
                         std::function<void( const wxString&, long long )> aPost,
                         std::function<void( long long, bool )> aResolve,
                         std::function<void( const VECTOR2I& )> aFocus );

    /// Re-render from the (tool-owned) comment array after a live update.
    void Reload();

    /// Select (and scroll to) one thread, e.g. after a pin was clicked.
    void SelectThread( long long aRootId );

private:
    long long selectedRootId() const;
    void      onSelectionChanged();

private:
    const nlohmann::json* m_comments;
    VECTOR2I              m_newAnchor;

    std::function<void( const wxString&, long long )> m_post;
    std::function<void( long long, bool )>            m_resolve;
    std::function<void( const VECTOR2I& )>            m_focus;

    wxDataViewListCtrl* m_threads;
    wxTextCtrl*         m_thread;
    wxTextCtrl*         m_input;
    wxButton*           m_replyBtn;
    wxButton*           m_resolveBtn;
    wxButton*           m_newBtn;
    wxButton*           m_showBtn;

    std::vector<long long> m_rowRootIds;
};
