'use strict';

(function () {
  var STORAGE_KEY = 'nerd__theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = theme === 'light' ? '☾' : '☀';
  }

  function savedTheme() {
    try { return localStorage.getItem(STORAGE_KEY) || 'dark'; } catch { return 'dark'; }
  }

  function toggleTheme() {
    var next = (document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
    applyTheme(next);
  }

  // Apply theme before first paint (when called from <head>)
  applyTheme(savedTheme());

  // Wire button once DOM is ready
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-btn');
    if (btn) btn.addEventListener('click', toggleTheme);
  });
})();
