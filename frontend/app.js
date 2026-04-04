'use strict';

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// NERD score → color (red → yellow → green)
// ---------------------------------------------------------------------------

function nerdColor(score) {
  // 0-5: interpolate red → yellow; 5-10: yellow → green
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCard(game) {
  const color = nerdColor(game.game_nerd);
  const barPct = (game.game_nerd / 10 * 100).toFixed(1);

  const isLive = game.status === 'Live';
  const statusDot = isLive ? '<span class="status-live"></span>' : '';

  const gameNum = game.game_number > 1 ? ` (Game ${game.game_number})` : '';
  const timeStr = game.game_time_et || 'TBD';

  // Flags
  let flagsHtml = '';
  if (game.flags && game.flags.length > 0) {
    const flagMap = {
      'TBD_starter':        ['flag-tbd', '⚠ Starter TBD'],
      'low_sample':         ['',         'small sample'],
      'used_fip_fallback':  ['',         'FIP used'],
      'no_velocity_data':   ['',         'no velo data'],
      'insufficient_data':  ['',         'limited data'],
    };
    const seen = new Set();
    const rendered = game.flags
      .filter(f => !seen.has(f) && seen.add(f))
      .filter(f => flagMap[f])
      .map(f => `<span class="flag ${flagMap[f][0]}">${flagMap[f][1]}</span>`)
      .join('');
    if (rendered) {
      flagsHtml = `<div class="flags">${rendered}</div>`;
    }
  }

  return `
    <article class="card">
      <div class="card-header" style="background: linear-gradient(135deg, ${color}22, ${color}08); border-bottom: 2px solid ${color}55;">
        <div>
          <div class="nerd-label">NERD</div>
          <div class="nerd-score" style="color: ${color}">${game.game_nerd.toFixed(1)}</div>
        </div>
        <div class="score-bar-wrap">
          <div class="score-bar-track">
            <div class="score-bar-fill" style="width: ${barPct}%; background: ${color};"></div>
          </div>
        </div>
      </div>
      <div class="card-body">
        <div class="matchup">${game.away.abbreviation} @ ${game.home.abbreviation}</div>
        <div class="game-meta">${statusDot}${timeStr} ET${gameNum} &bull; ${game.away.name} @ ${game.home.name}</div>
        <div class="pitchers">
          <div class="pitcher-row">
            <span class="pitcher-label">Away</span>
            <span class="pitcher-name">${game.away_pitcher.name}</span>
            <span class="pnerd-badge" style="color:${nerdColor(game.away_pnerd)}">${game.away_pnerd.toFixed(1)}</span>
          </div>
          <div class="pitcher-row">
            <span class="pitcher-label">Home</span>
            <span class="pitcher-name">${game.home_pitcher.name}</span>
            <span class="pnerd-badge" style="color:${nerdColor(game.home_pnerd)}">${game.home_pnerd.toFixed(1)}</span>
          </div>
        </div>
        <div class="tnerd-row">
          <div class="tnerd-item">
            <span>${game.away.abbreviation} tNERD:</span>
            <span class="tnerd-value">${game.away.tnerd.toFixed(1)}</span>
          </div>
          <div class="tnerd-item">
            <span>${game.home.abbreviation} tNERD:</span>
            <span class="tnerd-value">${game.home.tnerd.toFixed(1)}</span>
          </div>
        </div>
        ${flagsHtml}
      </div>
    </article>
  `;
}

function renderGames(data) {
  const grid = document.getElementById('cards');
  const noGames = document.getElementById('no-games');

  if (!data.games || data.games.length === 0) {
    grid.innerHTML = '';
    noGames.classList.remove('hidden');
    return;
  }

  noGames.classList.add('hidden');
  grid.innerHTML = data.games.map(renderCard).join('');
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

let currentDate = todayISO();

async function loadGames(dateISO) {
  const loading = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const grid = document.getElementById('cards');

  loading.classList.remove('hidden');
  errorEl.classList.add('hidden');
  grid.innerHTML = '';

  document.getElementById('date-display').textContent = formatDisplayDate(dateISO);

  try {
    const res = await fetch(`/api/games?date=${dateISO}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    loading.classList.add('hidden');
    renderGames(data);
  } catch (err) {
    loading.classList.add('hidden');
    errorEl.textContent = `Failed to load games: ${err.message}`;
    errorEl.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// Date navigation
// ---------------------------------------------------------------------------

document.getElementById('prev-day').addEventListener('click', () => {
  currentDate = shiftDate(currentDate, -1);
  loadGames(currentDate);
});

document.getElementById('next-day').addEventListener('click', () => {
  currentDate = shiftDate(currentDate, 1);
  loadGames(currentDate);
});

// ---------------------------------------------------------------------------
// Auto-refresh every 5 minutes
// ---------------------------------------------------------------------------

setInterval(() => {
  loadGames(currentDate);
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadGames(currentDate);
