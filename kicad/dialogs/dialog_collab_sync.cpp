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

#include "dialog_collab_sync.h"

#include <wx/radiobut.h>
#include <wx/sizer.h>
#include <wx/stattext.h>


DIALOG_COLLAB_SYNC::DIALOG_COLLAB_SYNC( wxWindow* aParent, const wxString& aProjectName,
                                        const wxString& aOnlineName, const wxString& aServer,
                                        const wxString& aRole, bool aOwner,
                                        bool aOnlineReachable, const wxString& aLocalPath ) :
        DIALOG_SHIM( aParent, wxID_ANY, _( "Online Sync" ), wxDefaultPosition, wxDefaultSize,
                     wxDEFAULT_DIALOG_STYLE )
{
    wxBoxSizer* mainSizer = new wxBoxSizer( wxVERTICAL );

    wxString status = wxString::Format( _( "'%s' is synced with the online project '%s'\n"
                                           "on %s (you are %s).\n\n"
                                           "Local copy: %s" ),
                                        aProjectName, aOnlineName, aServer, aRole, aLocalPath );

    if( !aOnlineReachable )
        status += _( "\n\nThe online project could not be reached right now." );

    mainSizer->Add( new wxStaticText( this, wxID_ANY, status ), 0, wxALL | wxEXPAND, 10 );

    m_keep = new wxRadioButton( this, wxID_ANY,
                                _( "Keep syncing (edits are merged with the online project)" ),
                                wxDefaultPosition, wxDefaultSize, wxRB_GROUP );
    m_unlink = new wxRadioButton( this, wxID_ANY,
                                  _( "Make this copy local only \u2014 stop syncing; the online "
                                     "project stays for others" ) );
    m_unlinkDrop = new wxRadioButton(
            this, wxID_ANY,
            aOwner ? _( "Make local and delete the online project (for everyone)" )
                   : _( "Make local and leave the online project" ) );
    m_deleteLocal = new wxRadioButton( this, wxID_ANY,
                                       _( "Delete this local copy \u2014 the online project stays; "
                                          "download it again any time" ) );

    m_keep->SetValue( true );
    m_unlinkDrop->Enable( aOnlineReachable );

    for( wxRadioButton* option : { m_keep, m_unlink, m_unlinkDrop, m_deleteLocal } )
        mainSizer->Add( option, 0, wxLEFT | wxRIGHT | wxBOTTOM, 10 );

    mainSizer->Add( CreateStdDialogButtonSizer( wxOK | wxCANCEL ), 0, wxEXPAND | wxALL, 5 );

    SetSizerAndFit( mainSizer );
    finishDialogSettings();
}


DIALOG_COLLAB_SYNC::CHOICE DIALOG_COLLAB_SYNC::GetChoice() const
{
    if( m_unlink->GetValue() )
        return CHOICE::UNLINK;

    if( m_unlinkDrop->GetValue() )
        return CHOICE::UNLINK_AND_DROP_ONLINE;

    if( m_deleteLocal->GetValue() )
        return CHOICE::DELETE_LOCAL;

    return CHOICE::KEEP;
}
