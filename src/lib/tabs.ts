import { invoke } from "@tauri-apps/api/core";

export interface Tab {
  id: string;
  url: string;
  title: string;
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
