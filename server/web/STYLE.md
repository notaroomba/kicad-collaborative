# Junction web style guide

One theme covers every page of the web product: the home page, the sign-in, join and authorize
pages, the projects window, the GitHub page, and the editor with its panes, dialogs, the Assistant
and plugins. The theme is one file, `server/static/theme.css`. The live guide, drawn with that
file, is at `/styleguide`.

## Principles

1. **It is KiCad.** Near-black and near-white chrome laid out like KiCad's own windows, dense
   rows, small radii, 1px rules. The design on the canvas is the only colourful thing on screen.
2. **Ink is the accent.** The primary button is a solid ink fill (near-black in light, near-white
   in dark); links, selection, focus and the active tab are neutral. There is no blue on chrome
   (the token is still called `--blue`).
   One primary button per view.
3. **Red means red.** Red is F.Cu, an error, or a destructive action. It never
   means "go".
4. **Colour comes from tokens.** No colour literal outside `theme.css`. Canvas drawing uses
   KiCad's own layer and schematic colours (`web/canvas/colors.ts`) and is the one exception.
5. **Light and dark are the same design.** Every surface works in both. `data-theme` on `<html>`
   (stored as `kui.theme`) overrides the system setting.
6. **Plain words.** Use KiCad's own label where KiCad has one. Sentence case, no exclamation
   marks, and an error says what to do next.

## Where things live

| What | Where |
| --- | --- |
| Tokens and shared components | `server/static/theme.css` (tokens above the `components` marker, classes below) |
| Tailwind names for the tokens (`bg-bench`, `text-ink-2`, `rounded-sm`) | `server/web/styles/tailwind.css` |
| Live guide | `server/static/styleguide.html`, `server/web/styleguide/index.ts`, served at `/styleguide` |
| How pages get the theme | `app.html` links `/static/theme.css`; `pages::STYLE`, the GitHub page and the guide inline it (`pages::THEME_CSS`); the home page inlines the tokens only (`github::theme_tokens()`) |

A page never defines a palette of its own; a test in `src/github.rs` fails if one does.

## Colour

| Token | Use |
| --- | --- |
| `--bench` | Chrome: toolbars, sidebars, title bars |
| `--paper` | Page and pane bodies, hover fill |
| `--panel` | Inputs, menus, cards, raised surfaces |
| `--line`, `--line-2` | 1px rules and control borders; the stronger one for hover and grid dots |
| `--ink`, `--ink-2`, `--ink-3` | Primary, secondary and caption text |
| `--accent`, `--accent-2`, `--on-accent` | Primary button fill and any filled selection that carries text; its border, hover and pressed; the text on it |
| `--blue` | Links, focus ring, active tab underline, tinted selection |
| `--sel`, `--sel-soft`, `--on`, `--on-line` | Selected row, hovered row, pressed toggle and its border |
| `--wire`, `--warn`, `--err`, `--err-2` | Ok and live, warning, error and destructive, destructive hover |
| `--teal` | Values and references, the editor role |
| `--copper`, `--copper-2` | F.Cu, the owner role. Not for buttons |
| `--canvas`, `--sheet`, `--silk`, `--mark` | Board background, schematic background, silkscreen, canvas annotations. The same in both themes |

Text on a filled `--accent`, `--err` or `--copper` surface is `--on-accent`. Do not put text on a
`--blue` fill: in the dark theme `--blue` is a light tint made for text and lines.

## Type

IBM Plex Sans for everything people read; IBM Plex Mono for what the design says (references,
values, coordinates, paths, counts, keys). Weights 400, 500 for controls, 600 for titles.

| Token | Size | Use |
| --- | --- | --- |
| `--fs-2xs` | 10 | Uppercase mono captions, badges |
| `--fs-xs` | 11 | Mono meta, keys, status bar |
| `--fs-sm` | 12 | Panes, property grids, dialog bodies |
| `--fs-base` | 13 | App body text, buttons, inputs, menus |
| `--fs-md` | 14 | Page body text, dialog titles |
| `--fs-lg` | 16 | Section headings |
| `--fs-xl` | 20 | Page titles |
| `--fs-2xl` | 28 | Display, home page only |

## Space, shape, depth

- Spacing is a 4px scale: `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 24, `--s-6` 32, `--s-7` 48.
- Radii: `--r-1` 2px for badges and keys, `--r-2` 3px for controls, `--r-3` 6px for menus, cards
  and dialogs, `--r-sheet` 12px for bottom sheets on narrow windows. Nothing rounder, except dots
  and avatars.
- Control heights: `--h-sm` 24 in dense editor rows, `--h-md` 28 in the app, `--h-lg` 34 on pages,
  `--h-touch` 40 on touch-sized windows.
- Depth: flat with a 1px rule by default, `--shadow` for menus, popovers and toasts,
  `--shadow-dialog` for dialogs over `--scrim`.
- The only gradient on chrome is the pane caption (paper to bench), as KiCad's docked panes have.
- Motion: `--dur-1` for hover and press, `--dur-2` for dialogs and menus, `--ease`. Honour
  `prefers-reduced-motion`.

## Components

| Component | Class | Notes |
| --- | --- | --- |
| Button | `.btn`, with `.primary`, `.danger`, `.danger.solid`, `.ghost`, `.on`, `.sm`, `.lg` | One primary per view. In a dialog the primary is rightmost, Cancel to its left |
| Field | `.input`, with `.mono`, `.lg`, `.bad` | Works on `input`, `select` and `textarea`. Focus is a `--blue` border, not a glow |
| Badge | `.pill`, with `.owner`, `.editor`, `.info`, `.ok`, `.warn`, `.err` | Outline only, mono, uppercase |
| Key | `.kbd` | |
| Callout | `.callout`, with `.ok`, `.warn`, `.err` | A message in the flow of a page |
| Segmented control | `.seg` with `button.on` | A row of exclusive choices |
| Box | `.box` with `h2` and `.in` | A titled group on a page |
| Dialog | `.kd-overlay`, `.kd-dialog`, `.kd-title`, `.kd-body`, `.kd-foot` | Title bar on `--paper`, body on `--bench`, buttons right-aligned |
| Spinner | `.spinner` | |
| Helpers | `.muted`, `.note`, `.mono`, `.empty`, `.row` | |

Area styles (`hp-` projects window, `ai-` Assistant, `plg-` plugins, `kp-` vendor parts, `klib-`
library chooser, `pd-` board dialogs) keep their own layout but take every colour, radius and size
from the tokens, and their buttons and fields match `.btn` and `.input`.

## The mark

The icon is a junction: two wires and the dot that joins them, in near-white on a near-black
rounded tile (`#FAFAFA` on `#111113`), with a hairline edge so the tile holds on dark pages. It is
one file, `server/static/icon.svg`, used by `pages::MARK`, `/favicon.svg`, the PNG and ICO sizes
drawn from it, the menu bar and the About dialog. Its colours belong to the icon only and are not
theme tokens. Use it at 18 to 20px in title bars; never recolour or redraw it.

## Adding UI

- Reach for a shared class first, then a token. In React chrome use the Tailwind names
  (`bg-panel border-line rounded-sm text-sm`); the stock Tailwind palette is switched off on
  purpose, so `bg-red-500` does not build.
- New colour needed? Add a token to `theme.css` in all three blocks (light, system dark, explicit
  dark) and a swatch to the guide.
- Check both themes and a narrow window before pushing.
