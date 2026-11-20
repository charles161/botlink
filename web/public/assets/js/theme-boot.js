// Runs before first paint (a classic, blocking script in <head>; CSP script-src 'self'): applies the remembered
// light/dark choice so the page never flashes the wrong theme. app.js owns the toggle; this only reads it.
(function () {
  var root = document.documentElement, t = null;
  try { t = localStorage.getItem("botlink-theme"); } catch (e) { /* private mode */ }
  if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
  var dark = t === "dark" || (t !== "light" && !!window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  var m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute("content", dark ? "#0e1c1d" : "#f6f2e8");
})();
