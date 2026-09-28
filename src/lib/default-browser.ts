import { invoke } from "@tauri-apps/api/core";

/** Whether macOS currently opens web links in this copy of twig. */
export function isDefaultBrowser(): Promise<boolean> {
  return invoke("is_default_browser");
}

/** Asks macOS to make twig the default; macOS shows its own prompt. */
export function makeDefaultBrowser(): Promise<void> {
  return invoke("make_default_browser");
}
