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

#include <dialog_shim.h>

class wxRadioButton;

/**
 * What to do with a project that is synced with an online project: keep
 * syncing, make it local only (with or without dropping the online side), or
 * delete the local copy.  The dialog only collects the choice; the project
 * manager carries it out.
 */
class DIALOG_COLLAB_SYNC : public DIALOG_SHIM
{
public:
    enum class CHOICE
    {
        KEEP,                     ///< no change
        UNLINK,                   ///< stop syncing; the online project stays
        UNLINK_AND_DROP_ONLINE,   ///< stop syncing and delete (owner) / leave (member) online
        DELETE_LOCAL,             ///< remove the local copy; the online project stays
    };

    DIALOG_COLLAB_SYNC( wxWindow* aParent, const wxString& aProjectName,
                        const wxString& aOnlineName, const wxString& aServer,
                        const wxString& aRole, bool aOwner, bool aOnlineReachable,
                        const wxString& aLocalPath );

    CHOICE GetChoice() const;

private:
    wxRadioButton* m_keep;
    wxRadioButton* m_unlink;
    wxRadioButton* m_unlinkDrop;
    wxRadioButton* m_deleteLocal;
};
