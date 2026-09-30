import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useTabStore } from "../store/tabs";
import { setOverlayActive } from "../lib/tabs";
import { useMenuAction } from "../lib/menu";
import { buildReport, fallbackIssueUrl, prepareScreenshot, sendReport, type ScreenshotData, type Setup } from "../lib/bug-report";
import { Icon } from "./Icon";
import "./ReportBug.css";

export function ReportBug() {
  const [open, setOpen] = useState(false);
  useMenuAction(["report-bug"], () => setOpen(true));
  return open ? <ReportForm onClose={() => setOpen(false)} /> : null;
}

type Status =
  | { kind: "editing" }
  | { kind: "sending" }
  | { kind: "sent"; number: number; url: string }
  | { kind: "failed"; error: string };

function ReportForm({ onClose }: { onClose: () => void }) {
  const newTab = useTabStore((s) => s.newTab);
  const [happened, setHappened] = useState("");
  const [expected, setExpected] = useState("");
  const [contact, setContact] = useState("");
  const [includeSetup, setIncludeSetup] = useState(true);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "editing" });
  const [screenshot, setScreenshot] = useState<ScreenshotData | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
    setOverlayActive(true, "report").catch(() => {});
    Promise.all([getVersion(), invoke<{ macos: string; chip: string }>("system_info")])
      .then(([version, info]) => setSetup({ version, ...info }))
      .catch(() => setSetup(null));
    return () => { setOverlayActive(false, "report").catch(() => {}); };
  }, []);

  const report = () =>
    buildReport({ happened, expected, contact, includeSetup: includeSetup && !!setup }, setup ?? { version: "", macos: "", chip: "" }, screenshot);

  async function attach(file: File | null | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    setShotError(null);
    try {
      setScreenshot(await prepareScreenshot(file));
    } catch (cause) {
      setShotError(cause instanceof Error ? cause.message : "Couldn't read that image.");
    }
  }

  async function send() {
    if (!happened.trim() || status.kind === "sending") return;
    setStatus({ kind: "sending" });
    const result = await sendReport(report());
    setStatus(result.ok ? { kind: "sent", number: result.number, url: result.url } : { kind: "failed", error: result.error });
  }

  function openAndClose(url: string) {
    void newTab(url);
    onClose();
  }

  return (
    <dialog
      ref={dialogRef}
      className="report"
      aria-labelledby="report-heading"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      // ⌘V with a screenshot on the clipboard, or dropping an image file.
      onPaste={(e) => {
        const image = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
        if (image) { e.preventDefault(); void attach(image); }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); void attach(e.dataTransfer.files[0]); }}
    >
      <header className="report-header">
        <h2 id="report-heading">Report a bug</h2>
        <button className="report-icon" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>

      {status.kind === "sent" ? (
        <div className="report-done" role="status">
          <p className="report-done-title">Filed as #{status.number}. Thank you.</p>
          <p className="report-help">It's a public issue on twig's GitHub, where you can follow what happens to it.</p>
          <div className="report-actions">
            <button className="report-button" onClick={() => openAndClose(status.url)}>View on GitHub</button>
            <button className="report-button primary" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <form className="report-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="report-field">
            <span>What happened?</span>
            <textarea value={happened} rows={4} autoFocus required maxLength={5000}
              placeholder="What you did, and what went wrong"
              onChange={(e) => setHappened(e.target.value)} />
          </label>
          <label className="report-field">
            <span>What did you expect? <em>Optional</em></span>
            <textarea value={expected} rows={2} maxLength={5000} onChange={(e) => setExpected(e.target.value)} />
          </label>
          <label className="report-field">
            <span>How can we reach you? <em>Optional</em></span>
            <input value={contact} maxLength={200} placeholder="GitHub username or email" onChange={(e) => setContact(e.target.value)} />
          </label>
          <div className="report-shot">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden
              onChange={(e) => { void attach(e.target.files?.[0]); e.target.value = ""; }} />
            {screenshot ? (
              <>
                <img className="report-thumb" alt="Screenshot to attach" src={`data:${screenshot.type};base64,${screenshot.data}`} />
                <button type="button" className="report-button quiet" aria-label="Remove screenshot" onClick={() => setScreenshot(null)}>
                  Remove
                </button>
              </>
            ) : (
              <>
                <button type="button" className="report-button" onClick={() => fileRef.current?.click()}>
                  Attach a screenshot
                </button>
                <span className="report-help">Optional. You can also paste (⌘V) or drop one here.</span>
              </>
            )}
          </div>
          {shotError && <p className="report-help" role="alert">{shotError}</p>}
          <label className="report-check">
            <input type="checkbox" checked={includeSetup} disabled={!setup} onChange={(e) => setIncludeSetup(e.target.checked)} />
            <span>
              Include versions
              <small>{setup ? `twig ${setup.version} · macOS ${setup.macos} · ${setup.chip}` : "Unavailable"}</small>
            </span>
          </label>
          <p className="report-help">
            Reports and screenshots become public GitHub issues. Nothing else is sent — not the page you're on, not your history.
          </p>
          {status.kind === "failed" && (
            <div className="report-error" role="alert">
              <p>{status.error}{screenshot ? " Your screenshot can be dragged onto the GitHub page." : ""}</p>
              <button type="button" className="report-button" onClick={() => openAndClose(fallbackIssueUrl(report()))}>
                Open on GitHub instead
              </button>
            </div>
          )}
          <div className="report-actions">
            <button type="button" className="report-button quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="report-button primary" disabled={!happened.trim() || status.kind === "sending"}>
              {status.kind === "sending" ? "Sending…" : "Send report"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
