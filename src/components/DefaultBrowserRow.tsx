import { useEffect, useState } from "react";
import { isDefaultBrowser, makeDefaultBrowser } from "../lib/default-browser";

// macOS answers "make twig the default?" in its own dialog, so the result
// arrives later: re-check when the window regains focus and for a little
// while after asking.
export function DefaultBrowserRow() {
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const check = () => isDefaultBrowser().then((yes) => { if (live) setIsDefault(yes); }).catch(() => {});
    check();
    window.addEventListener("focus", check);
    return () => { live = false; window.removeEventListener("focus", check); };
  }, []);

  async function ask() {
    setError(null);
    try {
      await makeDefaultBrowser();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    for (let i = 0; i < 30; i++) {
      if (await isDefaultBrowser().catch(() => false)) { setIsDefault(true); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return (
    <>
      <div className="settings-row">
        <span className="settings-label">
          Default browser
          <span className="settings-sub">
            {isDefault ? "twig is your default browser" : "Links you click in other apps open in another browser"}
          </span>
        </span>
        {isDefault === false && (
          <button className="settings-button" onClick={ask}>
            Make twig your default browser
          </button>
        )}
      </div>
      {error && <p className="settings-help" role="alert">{error}</p>}
    </>
  );
}
