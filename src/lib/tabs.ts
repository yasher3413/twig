import { invoke } from "@tauri-apps/api/core";

export type TabStatus = "hot" | "hibernated";

export interface Tab {
  id: string;
  url: string;
  title: string;
  status: TabStatus;
  groupId: string;
  /** Wall-clock ms the tab was last on screen. Survives restarts. */
  lastUsedAt: number;
}

export interface Group {
  id: string;
  name: string;
}

export interface TabsChangedPayload {
  tabs: Tab[];
  activeId: string | null;
  splitId: string | null;
  groups: Group[];
  activeGroupId: string;
  tabStripVisible: boolean;
  isPrivate: boolean;
}

/// Whether a tab's URL is one of our own internal pages (the new tab page,
/// currently a `data:` URL) rather than something the user navigated to -
/// used to keep the address bar, history, and command palette from showing
/// a raw base64 blob.
export function isInternalUrl(url: string): boolean {
  return url === "" || url.startsWith("data:") || url === "about:blank";
}

/** A tab with no URL yet: the chrome draws the new tab page for it and no
 *  webview exists, which is why an empty tab costs nothing. */
export function isNewTab(url: string): boolean {
  return url === "";
}

export function createTab(url?: string): Promise<Tab> {
  return invoke("create_tab", { url });
}

export function activateTab(id: string): Promise<void> {
  return invoke("activate_tab", { id });
}

export function closeTab(id: string): Promise<void> {
  return invoke("close_tab", { id });
}

export function listTabs(): Promise<TabsChangedPayload> {
  return invoke("list_tabs");
}

export function reorderTab(id: string, toIndex: number): Promise<void> {
  return invoke("reorder_tab", { id, toIndex });
}

export function navigateTab(id: string, url: string): Promise<Tab> {
  return invoke("navigate_tab", { id, url });
}

/** Slides page content down so a chrome popover has room, without hiding
 *  it. See set_content_offset in tabs.rs for why this beats the overlay
 *  for anything that isn't full-window. */
export function setContentOffset(offset: number): Promise<void> {
  return invoke("set_content_offset", { offset });
}

/** Narrows the page from the right for a side panel read alongside it.
 *  Pass 0 to give the page its full width back. */
export function setContentInset(right: number): Promise<void> {
  return invoke("set_content_inset", { right });
}

const overlayOwners = new Set<string>();
let overlayUpdate: Promise<void> = Promise.resolve();

export function setOverlayActive(open: boolean, owner: string): Promise<void> {
  if (open) overlayOwners.add(owner);
  else overlayOwners.delete(owner);
  const active = overlayOwners.size > 0;
  // A closing palette must not reveal native pages over a checkpoint
  // browser it just opened. Preserve ordering across the native bridge.
  overlayUpdate = overlayUpdate.catch(() => {}).then(() =>
    invoke<void>("set_overlay_active", { open: active }),
  );
  return overlayUpdate;
}

export function setSplit(id: string | null): Promise<void> {
  return invoke("set_split", { id });
}

export function createGroup(name?: string): Promise<Group> {
  return invoke("create_group", { name });
}

export function switchGroup(id: string): Promise<void> {
  return invoke("switch_group", { id });
}

export function closeGroup(id: string): Promise<void> {
  return invoke("close_group", { id });
}

export function renameGroup(id: string, name: string): Promise<void> {
  return invoke("rename_group", { id, name });
}

export function reopenClosedTab(): Promise<Tab | null> {
  return invoke("reopen_closed_tab");
}

export function toggleTabStrip(): Promise<boolean> {
  return invoke("toggle_tab_strip");
}

export function findInPage(query: string, backwards: boolean): Promise<void> {
  return invoke("find_in_page", { query, backwards });
}

export function openPrivateWindow(): Promise<void> {
  return invoke("open_private_window");
}

export function goBack(id: string): Promise<void> {
  return invoke("go_back", { id });
}

export function goForward(id: string): Promise<void> {
  return invoke("go_forward", { id });
}

/** Flips a tab in or out of reader view. */
export function toggleReader(id: string): Promise<void> {
  return invoke("toggle_reader", { id });
}

/** Starts link-hint mode: labels every clickable thing in view so it can
 *  be reached from the keyboard. */
export function followLink(id: string): Promise<void> {
  return invoke("follow_link", { id });
}

export interface MemoryStats {
  footprintKb: number;
  processCount: number;
  awakeTabs: number;
  sleepingTabs: number;
  estimatedSavedKb: number;
}

/** Live memory accounting. See memory_stats in tabs.rs for what's measured
 *  exactly and what's an estimate. */
export function memoryStats(): Promise<MemoryStats> {
  return invoke("memory_stats");
}

/** Steps zoom on a tab: 1 in, -1 out, 0 reset. Returns the new level. */
export function zoomTab(id: string, direction: number): Promise<number> {
  return invoke("zoom_tab", { id, direction });
}

/** Clears cookies and site data — the storage that keeps you signed in. */
export function clearSiteData(): Promise<void> {
  return invoke("clear_site_data");
}

/** How many tabs may stay awake at once. Rust clamps it to 2-12. */
export function setHotCap(cap: number): Promise<number> {
  return invoke("set_hot_cap", { cap });
}

export function setSearchEngine(template: string): Promise<void> {
  return invoke("set_search_engine", { template });
}

export function reloadTab(id: string): Promise<void> {
  return invoke("reload_tab", { id });
}
