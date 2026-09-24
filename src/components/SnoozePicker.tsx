import { useEffect, useMemo, useRef, useState } from "react";
import { useTabStore } from "../store/tabs";
import { useSnoozeStore } from "../store/snooze";
import { customWakeAt, dateTimeValue, snoozePresets } from "../lib/snooze";
import { canSnooze, snoozeTab } from "../lib/snooze-actions";
import { setOverlayActive } from "../lib/tabs";
import { useMenuAction } from "../lib/menu";
import "./SnoozePicker.css";

export function SnoozePicker() {
  const pickerFor = useSnoozeStore((s) => s.pickerFor);
  useMenuAction(["snooze-tab"], () => {
    const id = useTabStore.getState().activeId;
    if (id && canSnooze(id)) useSnoozeStore.getState().openPicker(id);
  });
  return pickerFor ? <Picker key={pickerFor} tabId={pickerFor} /> : null;
}

function Picker({ tabId }: { tabId: string }) {
  const close = useSnoozeStore((s) => s.closePicker);
  const title = useTabStore((s) => s.tabs.find((t) => t.id === tabId)?.title ?? "");
  const [now] = useState(() => new Date());
  const presets = useMemo(() => snoozePresets(now), [now]);
  const [selected, setSelected] = useState(0);
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => dateTimeValue(new Date(now.getTime() + 3_600_000)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const count = presets.length + 1;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    dialog?.focus();
    setOverlayActive(true, "snooze").catch(() => {});
    return () => { setOverlayActive(false, "snooze").catch(() => {}); };
  }, []);

  async function choose(at: number) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await snoozeTab(tabId, at);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  function pick(i: number) {
    setSelected(i);
    if (i < presets.length) void choose(presets[i].at);
    else setCustom(true);
  }

  return (
    <dialog
      ref={dialogRef}
      className="snooze"
      aria-labelledby="snooze-heading"
      tabIndex={-1}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.key === "ArrowDown") { e.preventDefault(); setSelected((i) => (i + 1) % count); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((i) => (i - 1 + count) % count); }
        else if (e.key === "Enter") { e.preventDefault(); pick(selected); }
        else if (/^[1-6]$/.test(e.key)) { e.preventDefault(); pick(Number(e.key) - 1); }
      }}
    >
      <h2 id="snooze-heading">Snooze until…</h2>
      <p className="snooze-tab">{title}</p>
      <ul className="snooze-options" role="listbox" aria-label="When it comes back" aria-activedescendant={`snooze-${selected}`}>
        {presets.map((p, i) => (
          <li key={p.id} id={`snooze-${i}`} role="option" aria-selected={i === selected}
            className={i === selected ? "snooze-option active" : "snooze-option"}
            onMouseMove={() => setSelected(i)} onClick={() => pick(i)}>
            <kbd>{i + 1}</kbd>
            <span className="snooze-label">{p.label}</span>
            <span className="snooze-detail">{p.detail}</span>
          </li>
        ))}
        <li id={`snooze-${presets.length}`} role="option" aria-selected={selected === presets.length}
          className={selected === presets.length ? "snooze-option active" : "snooze-option"}
          onMouseMove={() => setSelected(presets.length)} onClick={() => pick(presets.length)}>
          <kbd>{presets.length + 1}</kbd>
          <span className="snooze-label">Pick a date and time…</span>
        </li>
      </ul>
      {custom && (
        <form className="snooze-custom" onSubmit={(e) => {
          e.preventDefault();
          const at = customWakeAt(value, Date.now());
          if (at === null) setError("Pick a time at least a minute from now.");
          else void choose(at);
        }}>
          <input type="datetime-local" aria-label="Wake at" value={value} autoFocus onChange={(e) => setValue(e.target.value)} />
          <button type="submit" disabled={busy}>Snooze</button>
        </form>
      )}
      {error && <p className="snooze-error" role="alert">{error}</p>}
    </dialog>
  );
}
