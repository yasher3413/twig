import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------
// First-run state
// ---------------------------------------------------------------------

const DONE_KEY = "twig:welcome-done";

export function hasFinishedWelcome(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markWelcomeDone() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* private storage failures just mean the welcome shows again */
  }
}

export type WelcomeStep = "welcome" | "you" | "look" | "tour" | "keys" | "ready";

/** Opens the welcome flow, optionally at a specific step - Settings uses
 *  this to jump straight to shortcut editing. */
export function openWelcome(step: WelcomeStep = "welcome") {
  window.dispatchEvent(new CustomEvent("twig:welcome", { detail: { step } }));
}

/** "Good evening, Yash" - or just "Good evening" before a name is given. */
export function greeting(name: string, now = new Date()): string {
  const h = now.getHours();
  const part = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

// ---------------------------------------------------------------------
// Bookmark import
// ---------------------------------------------------------------------

export interface FoundBrowser {
  id: string;
  name: string;
  count: number;
}

export interface ImportedBookmark {
  url: string;
  title: string;
}

export function detectBrowsers(): Promise<FoundBrowser[]> {
  return invoke("detect_browsers");
}

export function readBrowserBookmarks(id: string): Promise<ImportedBookmark[]> {
  return invoke("read_browser_bookmarks", { id });
}

// ---------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------

export interface Binding {
  id: string;
  label: string;
  group: string;
  default: string;
  current: string;
}

export function getKeymap(): Promise<Binding[]> {
  return invoke("get_keymap");
}

/** Only the shortcuts that differ from their defaults need sending. */
export function setKeymap(overrides: Record<string, string>): Promise<void> {
  return invoke("set_keymap", { overrides });
}

/** While recording, the menu's accelerators are stripped - macOS would
 *  otherwise act on Cmd+T before the recorder ever saw it. */
export function suspendShortcuts(suspended: boolean): Promise<void> {
  return invoke("suspend_shortcuts", { suspended });
}

const MOD_ORDER = ["CmdOrCtrl", "Ctrl", "Alt", "Shift"] as const;

const KEY_ALIASES: Record<string, string> = {
  ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote",
  "=": "Equal", "-": "Minus", "[": "BracketLeft", "]": "BracketRight",
  "\\": "Backslash", "`": "Backquote", PLUS: "Equal",
};

function canonKey(key: string): string {
  if (KEY_ALIASES[key]) return KEY_ALIASES[key];
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

/** One spelling per shortcut, so "CmdOrCtrl+," and "CmdOrCtrl+Comma" -
 *  a default and a recording of the same keys - compare equal. */
export function canonAccel(accel: string): string {
  if (!accel) return "";
  const parts = accel.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((m) =>
    m === "Cmd" || m === "Command" || m === "Super" ? "CmdOrCtrl" : m === "Control" ? "Ctrl" : m === "Option" ? "Alt" : m,
  );
  const ordered = MOD_ORDER.filter((m) => mods.includes(m));
  return [...ordered, canonKey(key)].join("+");
}

const KEY_GLYPHS: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Equal: "=",
  Minus: "−", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Enter: "↩",
  Space: "Space", Tab: "⇥", Backspace: "⌫", Delete: "⌦", Escape: "esc",
};

/** macOS order and glyphs: ⌃⌥⇧⌘ then the key. */
export function displayAccel(accel: string): string[] {
  if (!accel) return [];
  const canon = canonAccel(accel).split("+");
  const key = canon.pop() ?? "";
  const glyphs: string[] = [];
  if (canon.includes("Ctrl")) glyphs.push("⌃");
  if (canon.includes("Alt")) glyphs.push("⌥");
  if (canon.includes("Shift")) glyphs.push("⇧");
  if (canon.includes("CmdOrCtrl")) glyphs.push("⌘");
  const label = KEY_GLYPHS[key] ?? key.replace(/^Key/, "").replace(/^Digit/, "");
  return [...glyphs, label];
}

export type Recorded =
  | { kind: "pending" }
  | { kind: "clear" }
  | { kind: "cancel" }
  | { kind: "invalid"; reason: string }
  | { kind: "accel"; accel: string };

/** Turns a keypress into an accelerator, or says why it can't be one. */
export function recordKey(e: KeyboardEvent): Recorded {
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"].includes(e.key)) return { kind: "pending" };
  if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) return { kind: "cancel" };
  if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return { kind: "clear" };
  }
  const isFunctionKey = /^F\d{1,2}$/.test(e.code);
  if (!e.metaKey && !e.ctrlKey && !e.altKey && !isFunctionKey) {
    return { kind: "invalid", reason: "Include ⌘, ⌃ or ⌥ — a bare key would fire while you type." };
  }
  const mods: string[] = [];
  if (e.metaKey) mods.push("CmdOrCtrl");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return { kind: "accel", accel: canonAccel([...mods, e.code].join("+")) };
}

/** Shortcuts owned by macOS or by twig's fixed items. Rebinding onto
 *  these would either do nothing or quietly break something basic. */
export const RESERVED: Record<string, string> = Object.fromEntries(
  [
    ["CmdOrCtrl+KeyQ", "Quit"],
    ["CmdOrCtrl+KeyH", "Hide twig"],
    ["CmdOrCtrl+Alt+KeyH", "Hide others"],
    ["CmdOrCtrl+KeyM", "Minimize"],
    ["CmdOrCtrl+KeyC", "Copy"],
    ["CmdOrCtrl+KeyV", "Paste"],
    ["CmdOrCtrl+KeyX", "Cut"],
    ["CmdOrCtrl+KeyZ", "Undo"],
    ["CmdOrCtrl+Shift+KeyZ", "Redo"],
    ["CmdOrCtrl+KeyA", "Select all"],
    ...Array.from({ length: 9 }, (_, i) => [`CmdOrCtrl+Digit${i + 1}`, `Go to tab ${i + 1}`]),
  ].map(([k, v]) => [canonAccel(k), v]),
);
