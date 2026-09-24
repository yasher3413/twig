import { decide } from "./changes";
import { copiesBefore, getRecallCopy, type RecallCapture } from "./recall-db";
import { useChangeStore } from "../store/changes";
import { useTabStore } from "../store/tabs";

/** Compares a fresh capture with what you last read. Must run before the
 *  capture is indexed, or the capture would become its own baseline. */
export async function checkForChange(capture: RecallCapture): Promise<void> {
  const { tabId } = capture;
  if (!tabId) return;
  const copies = await copiesBefore(capture.url, capture.capturedAt, 3);
  const decision = decide({
    url: capture.url,
    body: capture.body,
    capturedAt: capture.capturedAt,
    copies,
    muted: useChangeStore.getState().muted,
  });
  // The tab may have moved on while the query ran.
  const tab = useTabStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab || tab.url !== capture.url) return;
  if (decision.action === "set") useChangeStore.getState().set(tabId, decision.change);
  else if (decision.action === "clear") useChangeStore.getState().clear(tabId);
}

/** Keeps flagged changes honest: gone when the tab navigates or closes,
 *  gone when the copy they compare against is forgotten. */
export function watchChanges(): () => void {
  const unsubscribe = useTabStore.subscribe((s) => useChangeStore.getState().prune(s.tabs));
  const recallChanged = () => {
    for (const [tabId, change] of Object.entries(useChangeStore.getState().byTab)) {
      getRecallCopy(change.baselineId)
        .then((copy) => { if (!copy) useChangeStore.getState().clear(tabId); })
        .catch(() => {});
    }
  };
  window.addEventListener("twig:recall-changed", recallChanged);
  return () => {
    unsubscribe();
    window.removeEventListener("twig:recall-changed", recallChanged);
  };
}
