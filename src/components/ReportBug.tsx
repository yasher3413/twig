import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useTabStore } from "../store/tabs";
import { setOverlayActive } from "../lib/tabs";
import { useMenuAction } from "../lib/menu";
import { buildReport, fallbackIssueUrl, sendReport, type Setup } from "../lib/bug-report";
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
    buildReport({ happened, expected, contact, includeSetup: includeSetup && !!setup }, setup ?? { version: "", macos: "", chip: "" });

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
          <label className="report-check">
            <input type="checkbox" checked={includeSetup} disabled={!setup} onChange={(e) => setIncludeSetup(e.target.checked)} />
            <span>
              Include versions
              <small>{setup ? `twig ${setup.version} · macOS ${setup.macos} · ${setup.chip}` : "Unavailable"}</small>
            </span>
          </label>
          <p className="report-help">
            Reports become public GitHub issues. Nothing else is sent — not the page you're on, not your history.
          </p>
          {status.kind === "failed" && (
            <div className="report-error" role="alert">
              <p>{status.error}</p>
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
