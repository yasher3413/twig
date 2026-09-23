import { invoke } from "@tauri-apps/api/core";
import type { Checkpoint } from "./checkpoints";

export interface ResearchPage {
  url: string;
  title: string;
  note: string;
  excerpts: string[];
  capturedAt: number;
}

export interface ResearchPackage {
  format: "twig-research";
  version: 1;
  title: string;
  description: string;
  createdAt: number;
  pages: ResearchPage[];
  sourceCheckpoint: { name: string; createdAt: number } | null;
}

export interface SavedResearchPackage {
  id: string;
  savedAt: number;
  package: ResearchPackage;
}

export interface DraftPage extends ResearchPage {
  key: string;
  included: boolean;
}

export interface ResearchDraft extends Omit<ResearchPackage, "pages"> {
  pages: DraftPage[];
}

export type ResearchSource = "current" | Checkpoint;
export interface ResearchExcerpt { url: string; text: string }

export function shareableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

export function draftFromPages(
  title: string,
  pages: { url: string; title: string }[],
  createdAt = Date.now(),
  excerpt?: ResearchExcerpt | null,
): ResearchDraft {
  return {
    format: "twig-research", version: 1, title: title.slice(0, 120),
    description: "", createdAt, sourceCheckpoint: null,
    pages: pages.filter((page) => shareableUrl(page.url)).map((page, index) => ({
      key: String(index), included: true, url: page.url,
      title: (page.title || new URL(page.url).hostname).slice(0, 500),
      note: "", capturedAt: createdAt,
      excerpts: excerpt?.url === page.url && excerpt.text.trim() ? [excerpt.text.slice(0, 8000)] : [],
    })),
  };
}

export function draftFromPackage(value: ResearchPackage): ResearchDraft {
  return { ...value, sourceCheckpoint: value.sourceCheckpoint ? { ...value.sourceCheckpoint } : null,
    pages: value.pages.map((page, index) => ({ ...page, excerpts: [...page.excerpts], key: String(index), included: true })) };
}

export function packageFromDraft(draft: ResearchDraft, includeSource: boolean): ResearchPackage {
  return {
    format: "twig-research", version: 1, title: draft.title.trim(),
    description: draft.description.trim(), createdAt: draft.createdAt,
    sourceCheckpoint: includeSource && draft.sourceCheckpoint ? { ...draft.sourceCheckpoint } : null,
    pages: draft.pages.filter((page) => page.included).map((page) => ({
      url: page.url.trim(), title: page.title.trim(), note: page.note.trim(),
      excerpts: page.excerpts.map((text) => text.trim()).filter(Boolean), capturedAt: page.capturedAt,
    })),
  };
}

export function moveDraftPage(pages: DraftPage[], key: string, direction: -1 | 1): DraftPage[] {
  const from = pages.findIndex((page) => page.key === key);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= pages.length) return pages;
  const moved = [...pages];
  [moved[from], moved[to]] = [moved[to], moved[from]];
  return moved;
}

export const listResearchPackages = (): Promise<SavedResearchPackage[]> => invoke("list_research_packages");
export const saveResearchPackage = (value: ResearchPackage, id: string | null): Promise<SavedResearchPackage> =>
  invoke("save_research_package", { package: value, id });
export const deleteResearchPackage = (id: string): Promise<void> => invoke("delete_research_package", { id });
export const parseResearchPackage = (contents: string): Promise<ResearchPackage> => invoke("parse_research_package", { contents });
export const exportResearchPackage = (value: ResearchPackage, format: "twig" | "markdown" | "html"): Promise<string> =>
  invoke("export_research_package", { package: value, format });
export const openResearchPackage = (value: ResearchPackage): Promise<void> => invoke("open_research_package", { package: value });
export const captureResearchExcerpt = (): Promise<ResearchExcerpt | null> => invoke("capture_research_excerpt");

export async function openResearchPackages(source?: ResearchSource): Promise<void> {
  // Capture the selection before a native overlay moves keyboard focus.
  const excerpt = source === "current" ? await captureResearchExcerpt().catch(() => null) : null;
  window.dispatchEvent(new CustomEvent("twig:research", { detail: { source, excerpt } }));
}
