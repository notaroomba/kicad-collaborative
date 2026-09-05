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
#include <wx/frame.h>
#include <wx/longlong.h>
#include <wx/timer.h>

class wxBoxSizer;
class wxButton;
class wxPanel;
class wxTextCtrl;

/**
 * Hover card for a comment thread, the Figma gesture: hovering a pin slides a
 * card in beside it with the thread, a reply box and Resolve.  A borderless
 * tool window floating on the editor; it never takes focus until the user
 * clicks into the reply box.
 */
class COLLAB_COMMENT_CARD : public wxFrame
{
public:
    using REPLY_FN = std::function<void( const wxString& aBody, long long aRootId )>;
    using RESOLVE_FN = std::function<void( long long aRootId, bool aResolved )>;

    COLLAB_COMMENT_CARD( wxWindow* aParent, REPLY_FN aReply, RESOLVE_FN aResolve );

    /// Show the thread rooted at aRootId beside aScreenAnchor (the pin, in screen coords).
    void ShowThread( const nlohmann::json& aComments, long long aRootId,
                     const wxPoint& aScreenAnchor );

    /// Re-render the shown thread from fresh data, keeping any reply draft.
    void Reload( const nlohmann::json& aComments );

    void HideCard();

    long long ThreadId() const { return m_rootId; }

    /// True when aPt (screen coords) is over the card, with a little slack.
    bool ContainsScreenPoint( const wxPoint& aPt ) const;

    /// True while the reply box has focus or holds a draft — keep the card open.
    bool HasFocusedInput() const;

private:
    void rebuild( const nlohmann::json& aComments );
    void onAnimate( wxTimerEvent& aEvent );
    void onReply( wxCommandEvent& aEvent );
    void onResolve( wxCommandEvent& aEvent );

    static wxString relativeTime( const std::string& aIso );

    REPLY_FN   m_reply;
    RESOLVE_FN m_resolve;
    long long  m_rootId = -1;
    bool       m_resolved = false;

    wxPanel*    m_panel = nullptr;
    wxBoxSizer* m_sizer = nullptr;
    wxTextCtrl* m_input = nullptr;
    wxButton*   m_resolveBtn = nullptr;

    wxTimer    m_anim;
    wxLongLong m_animStart;
    wxPoint    m_animFrom;
    wxPoint    m_animTo;
};
