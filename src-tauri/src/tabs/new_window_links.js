// Links that ask for a new window (target="_blank", or a named target) did
// nothing in twig: WebKit never asked twig to open them (#4). window.open()
// does reach twig - a click is still a user gesture here - so a new-window
// link click becomes window.open(), which twig turns into a tab. Runs in the
// bubble phase so the page's own handlers go first; a click a site cancels
// stays cancelled.
(() => {
  const keepsTab = new Set(["", "_self", "_parent", "_top"]);
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href][target]") : null;
    if (!link || keepsTab.has(link.target.toLowerCase())) return;
    if (!/^https?:/i.test(link.href)) return;
    event.preventDefault();
    const target = link.target.toLowerCase() === "_blank" ? "_blank" : link.target;
    window.open(link.href, target, link.relList.contains("noopener") || link.relList.contains("noreferrer") ? "noopener" : "");
  });
})();
