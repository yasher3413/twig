import { useState } from "react";

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Favicons come from Google's public icon service, the same place search
// goes. Falls back to the host's initial when it 404s or there's no
// network, so a row is never left with a blank square.
export function SiteMark({ url, size = 28 }: { url: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const host = hostOf(url);
  const style = { width: size, height: size };

  if (failed) {
    return (
      <span className="site-mark site-mark-letter" style={style}>
        {host.charAt(0).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      className="site-mark"
      style={style}
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
