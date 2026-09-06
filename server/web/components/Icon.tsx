// Icon.tsx — KiCad's own icons (light + dark variants from resources/bitmaps_png, chosen by
// the `dark:` variant on the .lt / .dk groups) and the stroke glyphs of the collab tools.
import { SPEC } from "../spec";

/* `kicon` / `lt` / `dk` stay as plain hooks; the sizing and the light/dark swap are the utilities. */
const ICON = "kicon block w-6 h-6";

export function KIcon({ name, size }: { name: string | null | undefined; size?: number }) {
  const ic = name ? SPEC.icons[name] : undefined;
  if (!ic) {
    return (
      <svg className={ICON} viewBox="0 0 24 24" aria-hidden="true" width={size} height={size}>
        <rect x="5" y="5" width="14" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    );
  }
  return (
    <svg className={ICON} viewBox={ic.vb || "0 0 24 24"} aria-hidden="true" width={size} height={size}>
      <g className="lt dark:hidden" dangerouslySetInnerHTML={{ __html: ic.light || ic.dark || "" }} />
      <g className="dk hidden dark:inline" dangerouslySetInnerHTML={{ __html: ic.dark || ic.light || "" }} />
    </svg>
  );
}

/** A 24×24 stroke glyph given as inline SVG markup (module tools, the collab buttons). */
export function Glyph({ svg }: { svg: string }) {
  return (
    <svg className={ICON + " fill-none stroke-current stroke-[1.8] [stroke-linecap:round] [stroke-linejoin:round]"}
      viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
