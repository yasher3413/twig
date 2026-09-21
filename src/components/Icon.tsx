import type { ReactNode } from "react";

// One icon system, drawn rather than borrowed from the emoji table: every
// glyph sits on a 16x16 grid at a 1.5 stroke with round caps, so they hold
// together at the 14-16px sizes the chrome actually uses.

export type IconName =
  | "back"
  | "forward"
  | "reload"
  | "plus"
  | "close"
  | "settings"
  | "chevron-down"
  | "lock"
  | "globe"
  | "split"
  | "up"
  | "down"
  | "search"
  | "incognito";

const PATHS: Record<IconName, ReactNode> = {
  back: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  forward: <path d="M6 3.5 10.5 8 6 12.5" />,
  reload: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
    </>
  ),
  plus: <path d="M8 3.75v8.5M3.75 8h8.5" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  settings: (
    <>
      <path d="M3 5h10M3 11h10" />
      <circle cx="6.5" cy="5" r="1.75" />
      <circle cx="10" cy="11" r="1.75" />
    </>
  ),
  "chevron-down": <path d="M4 6.5 8 10.5l4-4" />,
  lock: (
    <>
      <rect x="3.75" y="7" width="8.5" height="6" rx="1.5" />
      <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M2.75 8h10.5" />
      <path d="M8 2.75c1.4 1.6 2.1 3.4 2.1 5.25S9.4 11.65 8 13.25c-1.4-1.6-2.1-3.4-2.1-5.25S6.6 4.35 8 2.75Z" />
    </>
  ),
  split: (
    <>
      <rect x="2.75" y="3.25" width="10.5" height="9.5" rx="1.5" />
      <path d="M8 3.25v9.5" />
    </>
  ),
  up: <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />,
  down: <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />,
  search: (
    <>
      <circle cx="7.25" cy="7.25" r="4" />
      <path d="M10.25 10.25 13.25 13.25" />
    </>
  ),
  // A sprig rather than the usual spy-glasses: private windows are still
  // twig, just not writing anything down.
  incognito: (
    <>
      <path d="M8 13.5V6" />
      <path d="M8 8.5C8 6.5 6.4 5 4.5 5c0 2 1.6 3.5 3.5 3.5Z" />
      <path d="M8 7.5c0-2 1.6-3.5 3.5-3.5 0 2-1.6 3.5-3.5 3.5Z" />
    </>
  ),
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
