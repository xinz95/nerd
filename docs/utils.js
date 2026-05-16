'use strict';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d + days).toISOString().slice(0, 10);
}

// NERD score → color (red → yellow → green)
function nerdColor(score) {
  const s = Math.max(0, Math.min(10, score));
  let r, g, b;
  if (s <= 5) {
    const t = s / 5;
    r = Math.round(224 + (232 - 224) * t);
    g = Math.round(82  + (184 - 82)  * t);
    b = Math.round(82  + (75  - 82)  * t);
  } else {
    const t = (s - 5) / 5;
    r = Math.round(232 + (76  - 232) * t);
    g = Math.round(184 + (175 - 184) * t);
    b = Math.round(75  + (116 - 75)  * t);
  }
  return `rgb(${r},${g},${b})`;
}

// Qualifying threshold for pNERD — scales with how far into the current season we are.
// Returns { minIp, minGs }; a pitcher qualifies if EITHER condition is met.
// Use Infinity for minIp when there is no IP floor (GS-only months).
// Completed seasons always use GS ≥ 10 (full-season standard).
function getQualifyingThreshold(statsYear) {
  const currentYear = new Date().getFullYear();
  if (statsYear < currentYear) return { minIp: Infinity, minGs: 10 };
  const month = new Date().getMonth() + 1; // 1-indexed
  if (month <= 5) return { minIp: 30, minGs: 5 };   // May
  if (month === 6) return { minIp: 50, minGs: 6 };   // June
  if (month === 7) return { minIp: Infinity, minGs: 7 };  // July
  if (month === 8) return { minIp: Infinity, minGs: 8 };  // August
  return { minIp: Infinity, minGs: 10 };              // September and beyond
}

// Cell coloring from directional z-score (positive = good)
function zStyle(z) {
  if (z == null) return '';
  const c = Math.max(-2.5, Math.min(2.5, z));
  if (c >  0.35) return `color:rgba(76,175,116,${(0.55 + Math.min(c, 2) * 0.2).toFixed(2)})`;
  if (c < -0.35) return `color:rgba(224,82,82,${(0.55 + Math.min(Math.abs(c), 2) * 0.2).toFixed(2)})`;
  return '';
}
