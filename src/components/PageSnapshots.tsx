import { useEffect, useState } from "react";
import type { PageSnapshot } from "../lib/tabs";

// Stand-ins for the pages while an overlay is up: each visible page is
// pictured just before it's hidden and drawn in the same spot, beneath the
// overlay, so Settings and the rest open over your page rather than over
// an empty window.
export function PageSnapshots() {
  const [snapshots, setSnapshots] = useState<PageSnapshot[]>([]);
  useEffect(() => {
    const show = (e: Event) => setSnapshots((e as CustomEvent<PageSnapshot[]>).detail ?? []);
    window.addEventListener("twig:page-snapshots", show);
    return () => window.removeEventListener("twig:page-snapshots", show);
  }, []);
  return (
    <>
      {snapshots.map((shot, i) => (
        <img
          key={i}
          className="page-snapshot"
          src={shot.image}
          alt=""
          style={{ position: "fixed", left: shot.x, top: shot.y, width: shot.width, height: shot.height, zIndex: 2, pointerEvents: "none" }}
        />
      ))}
    </>
  );
}
