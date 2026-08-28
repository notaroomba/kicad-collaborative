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

#include <collab/collab_cursor_item.h>

#include <deque>

#include <font/font.h>
#include <font/text_attributes.h>
#include <gal/graphics_abstraction_layer.h>
#include <geometry/eda_angle.h>
#include <math/util.h>
#include <view/view.h>

using KIGFX::COLOR4D;


KIGFX::COLOR4D COLLAB_CURSOR_ITEM::ParsePeerColor( const wxString& aColorStr )
{
    KIGFX::COLOR4D color;

    if( !color.SetFromHexString( aColorStr ) && !color.SetFromWxString( aColorStr ) )
        return KIGFX::COLOR4D( 0.27, 0.47, 0.93, 1.0 );

    return color;
}


COLLAB_CURSOR_ITEM::COLLAB_CURSOR_ITEM() :
        EDA_ITEM( NOT_USED )
{
}


COLLAB_CURSOR_ITEM::~COLLAB_CURSOR_ITEM() = default;


void COLLAB_CURSOR_ITEM::ViewDraw( int aLayer, KIGFX::VIEW* aView ) const
{
    KIGFX::GAL*  gal = aView->GetGAL();
    const double scale = gal->GetWorldScale();

    if( scale <= 0.0 || m_peers.empty() )
        return;

    // World units per screen pixel, so everything holds a constant on-screen size.
    const double w = 1.0 / scale;

    const double cursorPx = 16.0;    // pointer triangle height
    const double textPx = 12.0;      // name tag glyph height
    const double selLinePx = 1.5;    // selection outline width
    const double padPx = 3.0;        // name tag padding

    for( const REMOTE_PEER_DRAW& peer : m_peers )
    {
        // Selection outlines: thin screen-constant rectangles in the peer colour.
        gal->SetIsFill( false );
        gal->SetIsStroke( true );
        gal->SetStrokeColor( peer.color );
        gal->SetLineWidth( static_cast<float>( selLinePx * w ) );

        for( const BOX2I& box : peer.selectionBoxes )
            gal->DrawRectangle( box );

        if( !peer.hasCursor )
            continue;

        // Pointer triangle with its tip on the reported cursor position.
        const VECTOR2D tip( peer.cursor );

        std::deque<VECTOR2D> triangle = {
            tip,
            tip + VECTOR2D( 0.38 * cursorPx, cursorPx ) * w,
            tip + VECTOR2D( cursorPx, 0.38 * cursorPx ) * w,
        };

        gal->SetIsFill( true );
        gal->SetIsStroke( true );
        gal->SetFillColor( peer.color );
        gal->SetStrokeColor( COLOR4D( 1.0, 1.0, 1.0, 0.9 ) );
        gal->SetLineWidth( static_cast<float>( 1.0 * w ) );
        gal->DrawPolygon( triangle );

        if( peer.label.IsEmpty() )
            continue;

        // Name tag: a filled chip in the peer colour below-right of the pointer.
        // Text goes through KIFONT (gal->BitmapText draws nothing on every GAL),
        // which also gives a real measurement for the chip width.
        KIFONT::FONT*   font = KIFONT::FONT::GetFont();
        const double    textH = textPx * w;
        const double    pad = padPx * w;

        TEXT_ATTRIBUTES textAttrs;
        textAttrs.m_Size = VECTOR2I( KiROUND( textH ), KiROUND( textH ) );
        textAttrs.m_StrokeWidth = KiROUND( 0.15 * textH );
        textAttrs.m_Halign = GR_TEXT_H_ALIGN_LEFT;
        textAttrs.m_Valign = GR_TEXT_V_ALIGN_CENTER;

        const VECTOR2I extents = font->StringBoundaryLimits( peer.label, textAttrs.m_Size,
                                                             textAttrs.m_StrokeWidth, false, false,
                                                             KIFONT::METRICS::Default() );

        const VECTOR2D chipOrigin = tip + VECTOR2D( 0.8 * cursorPx, 1.2 * cursorPx ) * w;
        const VECTOR2D chipEnd = chipOrigin + VECTOR2D( extents.x + 2.0 * pad, textH + 2.0 * pad );

        gal->SetIsFill( true );
        gal->SetIsStroke( false );
        gal->SetFillColor( peer.color );
        gal->DrawRectangle( chipOrigin, chipEnd );

        const COLOR4D textColor = peer.color.GetBrightness() > 0.5
                                          ? COLOR4D( 0.0, 0.0, 0.0, 1.0 )
                                          : COLOR4D( 1.0, 1.0, 1.0, 1.0 );

        gal->SetIsFill( false );
        gal->SetIsStroke( true );
        gal->SetStrokeColor( textColor );
        gal->SetLineWidth( static_cast<float>( textAttrs.m_StrokeWidth ) );

        font->Draw( gal, peer.label,
                    VECTOR2I( KiROUND( chipOrigin.x + pad ),
                              KiROUND( ( chipOrigin.y + chipEnd.y ) / 2.0 ) ),
                    textAttrs, KIFONT::METRICS::Default() );
    }
}
