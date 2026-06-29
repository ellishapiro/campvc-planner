// Camp VC planner - light/dark theme.
// Default: follow the device's system setting (prefers-color-scheme).
// A toggle button (#themeToggle) lets each person override it; the choice is
// saved per device. Loaded in <head> so there's no flash of the wrong theme.
(function () {
  "use strict";

  // Register the network-first service worker so updates appear without a hard
  // refresh (GitHub Pages' 10-minute HTML cache otherwise hides them).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    });
  }

  var KEY = "campvc_theme";
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  if (saved === "light" || saved === "dark") {
    document.documentElement.setAttribute("data-theme", saved);
  }
  function effective() {
    var c = document.documentElement.getAttribute("data-theme");
    if (c) return c;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function label() {
    var b = document.getElementById("themeToggle");
    if (b) b.textContent = effective() === "light" ? "Dark mode" : "Light mode";
  }
  function toggle() {
    var next = effective() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(KEY, next); } catch (e) {}
    label();
  }
  window.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("themeToggle");
    if (b) { b.addEventListener("click", toggle); label(); }
  });
})();
