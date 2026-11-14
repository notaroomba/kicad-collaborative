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

/**
 * Product identity for the Junction fork.
 *
 * Everything a person sees (window titles, the setup wizard, the About
 * dialog, installers) carries this name and version so it is never mistaken
 * for a stock KiCad.  The underlying KiCad version (build_version.h) still
 * drives file formats, settings paths and versioned environment variables —
 * do not use these values for any of those.
 *
 * Keep KICAD_COLLAB_PRODUCT_VERSION in sync with packaging/VERSION.
 */
#define KICAD_COLLAB_PRODUCT_NAME     wxS( "Junction" )
#define KICAD_COLLAB_PRODUCT_VERSION  wxS( "2.1.0" )

/**
 * The KiCad release this fork is based on, as shown to people (About dialog).
 * The tree's own KICAD_VERSION is the 10.99 development number, which only means
 * "not a standard release"; it is not the release the product descends from.
 * Display only: never use it for file formats or settings paths.
 */
#define KICAD_COLLAB_BASE_KICAD       wxS( "10" )
