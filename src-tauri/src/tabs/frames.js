// In dark mode, WebKit paints an embedded frame's background solid white
// whenever the frame's own page doesn't also opt into dark - which is how
// Google's dark "Sign in with Google" card came to sit in a white box (#7).
// Letting frames keep their own colour scheme removes that. The rule goes
// first and has no specificity, so any site that styles its frames wins.
(() => {
  const add = () => {
    const style = document.createElement("style");
    style.textContent = ":where(iframe){color-scheme:normal}";
    (document.head || document.documentElement).prepend(style);
  };
  if (document.documentElement) add();
  else document.addEventListener("DOMContentLoaded", add, { once: true });
})();
