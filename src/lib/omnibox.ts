/// How a URL reads once the parts nobody types are stripped off, which is
/// also the form worth completing to: "https://www.github.com/x" -> the
/// "github.com/x" you'd actually have typed.
export function typeableForm(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

/// What to finish `typed` into, from pages you've been to (best first), or
/// null. While you're still typing a site's name it only completes the
/// site - "g" becomes "google.com", never an old search result. Once you've
/// typed past the site it completes the path, but stops before any query,
/// so it never fills in someone else's "?q=...".
export function inlineCompletion(typed: string, urls: string[]): string | null {
  const probe = typed.toLowerCase();
  if (!probe || /\s/.test(probe)) return null;
  const intoPath = probe.includes("/");
  for (const url of urls) {
    const full = typeableForm(url);
    const site = full.split("/")[0];
    let form = intoPath ? full : site;
    if (intoPath && !probe.includes("?")) form = form.split(/[?#]/)[0].replace(/\/$/, "");
    if (form.toLowerCase().startsWith(probe) && form.length > typed.length) return form;
  }
  return null;
}
