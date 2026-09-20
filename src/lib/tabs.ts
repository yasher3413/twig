import { invoke } from "@tauri-apps/api/core";

export type TabStatus = "hot" | "hibernated";

export interface Tab {
  id: string;
  url: string;
  title: string;
  status: TabStatus;
}

export interface TabsChangedPayload {
  tabs: Tab[];
  activeId: string | null;
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
