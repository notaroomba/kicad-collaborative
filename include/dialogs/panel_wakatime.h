/*
 * This program source code file is part of Junction, a KiCad fork.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the
 * Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef PANEL_WAKATIME_H
#define PANEL_WAKATIME_H

#include <widgets/resettable_panel.h>

class wxCheckBox;
class wxChoice;
class wxTextCtrl;
class wxStaticText;
class wxHyperlinkCtrl;

/**
 * Preferences → Common → WakaTime: whether the editors send WakaTime heartbeats, and the key
 * and server in ~/.wakatime.cfg that every WakaTime plugin shares (see WAKATIME).  The browser
 * editor has the same page, which keeps its key on the Junction server instead.
 */
class PANEL_WAKATIME : public RESETTABLE_PANEL
{
public:
    PANEL_WAKATIME( wxWindow* aParent );

    void ResetPanel() override;

    wxString GetResetTooltip() const override
    {
        return _( "Send heartbeats to WakaTime itself (the API key is kept)" );
    }

protected:
    bool TransferDataToWindow() override;
    bool TransferDataFromWindow() override;

private:
    void onServer( wxCommandEvent& aEvent );
    void onTest( wxCommandEvent& aEvent );
    void syncServer();

    wxCheckBox*      m_enabled;
    wxChoice*        m_server;
    wxTextCtrl*      m_url;
    wxTextCtrl*      m_key;
    wxHyperlinkCtrl* m_keyLink;
    wxStaticText*    m_keyNote;
    wxStaticText*    m_status;
    wxStaticText*    m_cli;
    wxString         m_savedKey;
    wxString         m_customUrl;
};

#endif // PANEL_WAKATIME_H
