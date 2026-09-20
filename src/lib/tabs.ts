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
