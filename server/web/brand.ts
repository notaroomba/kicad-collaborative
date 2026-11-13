/* The Junction icon's address.  It is versioned so that a changed icon gets a new URL: the server
   caches /brand/<ICON_V>/ for good, and no browser or CDN can keep serving an older mark (one did,
   showing the KiCad "Ki" icon after the rename).  Bump it together with ICON_V in src/pages.rs
   whenever static/icon.svg changes. */
export const ICON_V = "j2";
export const ICON_URL = `/brand/${ICON_V}/icon.svg`;
