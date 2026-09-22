import { invoke } from "@tauri-apps/api/core";

export interface CheckpointTab {
  id: string;
  url: string;
  title: string;
  scrollY: number;
}

export interface Checkpoint {
  id: string;
  name: string;
  note: string;
  createdAt: number;
  spaceName: string;
  parentId: string | null;
  tabs: CheckpointTab[];
  activeId: string | null;
  splitId: string | null;
}

export function listCheckpoints(): Promise<Checkpoint[]> {
  return invoke("list_checkpoints");
}

export function saveCheckpoint(name: string, note: string): Promise<Checkpoint> {
  return invoke("save_checkpoint", { name, note });
}

export function restoreCheckpoint(id: string, forkName?: string): Promise<void> {
  return invoke("restore_checkpoint", { id, forkName: forkName ?? null });
}

export function deleteCheckpoint(id: string): Promise<void> {
  return invoke("delete_checkpoint", { id });
}

// Chrome-local: opening this surface must never open it in other windows.
export function openCheckpoints(save = false): void {
  window.dispatchEvent(new CustomEvent("twig:checkpoints", { detail: { save } }));
}
