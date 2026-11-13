// keys.ts — how a hotkey reads on this platform.
//
// The web keeps every hotkey in KiCad's notation ("Ctrl+Shift+Z", "Alt+3", "Del"), the way the action tables
// spell them; this turns one into the text KiCad shows for it.  Elsewhere that text is the notation itself.  On
// a Mac it is what KiCad's macOS build shows (common/hotkeys_basic.cpp, USING_MAC_CMD):
//   • KeyNameFromKeyCode, used for tooltips ("Save  (Cmd+S)"), the hotkey list, status texts and labels:
//     MD_CTRL is wx's WXK_CONTROL, the Command key, written "Cmd+"; MD_ALT is "Option+"; Shift stays "Shift+",
//     in the order Cmd, Option, Shift.  The physical Control key (WXK_RAW_CONTROL) keeps the name "Ctrl".
//   • menus are native NSMenus: AddHotkeyName hands wx "\tCtrl+S" and macOS draws the key equivalent with its
//     glyphs, Control ⌃, Option ⌥, Shift ⇧, Command ⌘ in that order, no "+", the named keys as symbols.
// The key handling matches: Cmd is the Ctrl of the tables (editor/hotkeys.ts comboOf), Option is Alt.

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  if (nav.platform) return /Mac|iPhone|iPad|iPod/i.test(nav.platform);
  const uad = nav.userAgentData && nav.userAgentData.platform;
  if (uad) return /mac|ios/i.test(uad);
  return /Macintosh|Mac OS X|iPhone|iPad/.test(nav.userAgent || "");
}

/** A Mac (navigator.platform, else navigator.userAgentData, else the user agent). */
export const IS_MAC = detectMac();

/** A hotkey in KiCad's notation split into its modifiers and its key ("Ctrl++" is Ctrl and "+"). */
export function splitKey(key: string): { ctrl: boolean; alt: boolean; shift: boolean; rawCtrl: boolean; key: string } {
  const parts = key.split("+"); let k = parts.pop() ?? "";
  if (k === "" && key.endsWith("+")) { k = "+"; parts.pop(); }
  return { ctrl: parts.includes("Ctrl") || parts.includes("Cmd"), alt: parts.includes("Alt") || parts.includes("Option"), shift: parts.includes("Shift"), rawCtrl: parts.includes("RawCtrl"), key: k };
}

/**
 * KeyNameFromKeyCode: the hotkey as text, for tooltips, the hotkey list, labels and messages.  On a Mac
 * "Ctrl+Shift+Z" reads "Cmd+Shift+Z" and "Alt+3" "Option+3"; elsewhere the notation is the text.
 */
export function keyName(key: string | null | undefined): string {
  if (!key) return "";
  const s = splitKey(key);
  if (!IS_MAC) return s.rawCtrl ? key.replace("RawCtrl", "Ctrl") : key;
  const mods: string[] = [];
  if (s.rawCtrl) mods.push("Ctrl");
  if (s.ctrl) mods.push("Cmd");
  if (s.alt) mods.push("Option");
  if (s.shift) mods.push("Shift");
  return [...mods, s.key].join("+");
}

/** A modifier key's own name ("Ctrl", "Alt", "Shift" in KiCad's notation): "Cmd" and "Option" on a Mac. */
export function modName(mod: "Ctrl" | "Alt" | "Shift"): string { return keyName(`${mod}+X`).slice(0, -2); }

/** The named keys as a macOS menu draws them (NSMenuItem key equivalents). */
const MAC_MENU_KEYS: Record<string, string> = {
  Del: "⌦", Delete: "⌦", Backspace: "⌫", Back: "⌫", Esc: "⎋", Escape: "⎋", Tab: "⇥", Enter: "↩", Return: "↩",
  Up: "↑", Down: "↓", Left: "←", Right: "→", PgUp: "⇞", PgDn: "⇟", Home: "↖", End: "↘",
};

/**
 * The hotkey beside a menu entry (menu bar, context menus, drop-down menus).  On a Mac the native menu's key
 * equivalent: "Ctrl+Shift+Z" → "⇧⌘Z", "Alt+3" → "⌥3", "Del" → "⌦"; elsewhere the notation ("Ctrl+Shift+Z").
 */
export function menuKey(key: string | null | undefined): string {
  if (!key) return "";
  if (!IS_MAC) return keyName(key);
  const s = splitKey(key);
  return (s.rawCtrl ? "⌃" : "") + (s.alt ? "⌥" : "") + (s.shift ? "⇧" : "") + (s.ctrl ? "⌘" : "") + (MAC_MENU_KEYS[s.key] || s.key);
}

/** Every hotkey written in a sentence ("Press Ctrl+E again", "Ctrl+Enter posts") in this platform's names. */
export function keysInText(text: string): string {
  if (!IS_MAC) return text;
  return text.replace(/\b((?:(?:Ctrl|Alt|Shift)\+)+)(?=\S)/g, (mods) => (/Ctrl|Alt/.test(mods) ? keyName(mods + "x").slice(0, -1) : mods));
}

/** The unshifted and shifted character of each punctuation key on the US layout, by KeyboardEvent.code. */
const PUNCT_CODES: Record<string, [string, string]> = {
  Backquote: ["`", "~"], Minus: ["-", "_"], Equal: ["=", "+"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backslash: ["\\", "|"],
  Semicolon: [";", ":"], Quote: ["'", "\""], Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"], IntlBackslash: ["\\", "|"],
};

/**
 * KiCad names a shifted punctuation hotkey by the unshifted key ("Ctrl+Shift+." is Ctrl with Shift and the full stop
 * key, which types ">"): the combination spelled that way, from the physical key, or "" when it is not one.
 */
export function shiftedPunctCombo(ev: { code?: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): string {
  const p = ev.shiftKey && ev.code ? PUNCT_CODES[ev.code] : undefined; if (!p) return "";
  const mods: string[] = []; if (ev.ctrlKey || ev.metaKey) mods.push("Ctrl"); mods.push("Shift"); if (ev.altKey) mods.push("Alt");
  return [...mods, p[0]].join("+");
}

/**
 * The key a hotkey names for this event.  Option (Alt) composes another character on a Mac and on some layouts:
 * Option+S types "ß", Option+/ "÷", and Option+` is a dead key ("Dead").  wx matches the key code of the physical
 * key, so this does too: letters and digits always by their code while Alt is held, punctuation when the key
 * typed something else (a dead key or a character outside ASCII).  Null for an event that names no key.
 */
export function hotkeyKey(ev: { key: string; code?: string; altKey: boolean; shiftKey: boolean }): string | null {
  const k = ev.key;
  if (!k || k === "Unidentified") return null;
  if (ev.altKey && ev.code) {
    const m = /^(?:Key|Digit)(.)$/.exec(ev.code); if (m) return m[1];
    const p = PUNCT_CODES[ev.code];
    if (p && (k === "Dead" || k.length !== 1 || k.charCodeAt(0) > 0x7e)) return p[ev.shiftKey ? 1 : 0];
  }
  return k === "Dead" ? null : k;
}
