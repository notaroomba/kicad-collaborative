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

#include <eda_item.h>
#include <gal/color4d.h>
#include <layer_ids.h>
#include <math/box2.h>
#include <math/vector2d.h>
#include <wx/string.h>

namespace KIGFX
{
class VIEW;
}


/// What is drawn for one remote participant: their cursor (if on this sheet), a name
/// tag, and the bounding boxes of their current selection.
struct REMOTE_PEER_DRAW
{
    VECTOR2I           cursor;
    bool               hasCursor = false;
    wxString           label;
    KIGFX::COLOR4D     color;
    std::vector<BOX2I> selectionBoxes;
};


/**
 * Draws every remote peer's cursor, name tag and selection outline at a constant
 * on-screen size, like the edit handles.  One instance per canvas draws all peers;
 * the size is taken from the view scale every frame, so this is a ViewDraw item
 * rather than a cached overlay (same approach as CONSTRAINT_BADGE_ITEM).
 */
class COLLAB_CURSOR_ITEM : public EDA_ITEM
{
public:
    COLLAB_CURSOR_ITEM();

    ~COLLAB_CURSOR_ITEM() override;

    void SetPeers( std::vector<REMOTE_PEER_DRAW>&& aPeers ) { m_peers = std::move( aPeers ); }

    /**
     * Parse a server-supplied peer colour.
     *
     * COLOR4D's string constructor leaves its components uninitialized when the
     * string doesn't parse, so a malformed value would reach the GAL as
     * garbage.  Falls back to a readable default instead.
     */
    static KIGFX::COLOR4D ParsePeerColor( const wxString& aColorStr );

    const BOX2I ViewBBox() const override
    {
        BOX2I bbox;
        bbox.SetMaximum(); // Always drawn, so the per-frame screen-constant sizing stays current.
        return bbox;
    }

    std::vector<int> ViewGetLayers() const override { return { LAYER_GP_OVERLAY }; }

    void ViewDraw( int aLayer, KIGFX::VIEW* aView ) const override;

    bool HitTest( const VECTOR2I&, int = 0 ) const override { return false; }

    wxString GetClass() const override { return wxT( "COLLAB_CURSOR_ITEM" ); }

#if defined( DEBUG )
    void Show( int, std::ostream& ) const override {}
#endif

private:
    std::vector<REMOTE_PEER_DRAW> m_peers;
};
