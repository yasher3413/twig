import { invoke } from "@tauri-apps/api/core";

export type TabStatus = "hot" | "hibernated";

export interface Tab {
  id: string;
  url: string;
  title: string;
  status: TabStatus;
  groupId: string;
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

export function setOverlayActive(open: boolean): Promise<void> {
  return invoke("set_overlay_active", { open });
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

export function reloadTab(id: string): Promise<void> {
  return invoke("reload_tab", { id });
}
