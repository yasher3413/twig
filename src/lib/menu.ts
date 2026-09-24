import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

type Handler = (id: string) => void;

// One native listener for the whole chrome, fanned out in-process.
//
// Components used to call listen("menu-action") themselves - ten separate
// IPC registrations, every one woken by every shortcut. Worse, listen()
// and its unlisten are both async, so a component re-subscribing during a
// render could briefly hold two listeners at once and handle a single
// keypress twice (Cmd+D bookmarking, then un-bookmarking). Subscribing
// here is synchronous, so that window doesn't exist.
const handlers = new Set<Handler>();
let bridged = false;

function bridge() {
  if (bridged) return;
  bridged = true;
  listen<string>("menu-action", ({ payload }) => {
    for (const handler of handlers) handler(payload);
  });
}

export function onMenuAction(handler: Handler): () => void {
  bridge();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Runs `handler` for menu actions whose id is in `ids`. Subscribes once
 *  per mount; the handler is read through a ref, so it always sees current
 *  state without the effect having to re-run when that state changes. */
export function useMenuAction(ids: readonly string[], handler: Handler) {
  const latest = useRef(handler);
  latest.current = handler;
  const key = ids.join("|");

  useEffect(() => {
    const wanted = new Set(key.split("|"));
    return onMenuAction((id) => {
      if (wanted.has(id)) latest.current(id);
    });
  }, [key]);
}
