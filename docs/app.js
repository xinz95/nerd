'use strict';

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}

function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d + days).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// NERD score → color (red → yellow → green)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCard(game) {
  const color  = nerdColor(game.gameNerd);
  const barPct = (game.gameNerd / 10 * 100).toFixed(1);
  const isLive = game.status === 'Live';
  const gameNum = game.gameNumber > 1 ? ` · Game ${game.gameNumber}` : '';

  const FLAG_MAP = {
    TBD_starter:       ['flag-tbd', '⚠ Starter TBD'],
    low_sample:        ['', 'small sample'],
    used_fip_fallback: ['', 'FIP used'],
    no_pitch_data:     ['', 'no pitch data'],
    insufficient_data: ['', 'limited data'],
    prior_year_stats:  ['', '2025 stats'],
  };
  const seen = new Set();
  const flagsHtml = (game.flags || [])
    .filter(f => FLAG_MAP[f] && !seen.has(f) && seen.add(f))
    .map(f => `<span class="flag ${FLAG_MAP[f][0]}">${FLAG_MAP[f][1]}</span>`)
    .join('');

  return `
    <article class="card">
      <div class="card-header" style="background:linear-gradient(135deg,${color}22,${color}08);border-bottom:2px solid ${color}55">
        <div>
          <div class="nerd-label">NERD</div>
          <div class="nerd-score" style="color:${color}">${game.gameNerd.toFixed(1)}</div>
        </div>
        <div class="score-bar-wrap">
          <div class="score-bar-track">
            <div class="score-bar-fill" style="width:${barPct}%;background:${color}"></div>
          </div>
        </div>
      </div>
      <div class="card-body">
        <div class="matchup">${game.awayTeamAbbr} @ ${game.homeTeamAbbr}</div>
        <div class="game-meta">
          ${isLive ? '<span class="status-live"></span>' : ''}${game.gameTimeET} ET${gameNum}
          &bull; ${game.awayTeamName} @ ${game.homeTeamName}
        </div>
        <div class="pitchers">
          <div class="pitcher-row">
            <span class="pitcher-label">Away</span>
            <span class="pitcher-name">${game.awayPitcherName}</span>
            <span class="pnerd-badge" style="color:${nerdColor(game.awayPnerd)}">${game.awayPnerd.toFixed(1)}</span>
          </div>
          <div class="pitcher-row">
            <span class="pitcher-label">Home</span>
            <span class="pitcher-name">${game.homePitcherName}</span>
            <span class="pnerd-badge" style="color:${nerdColor(game.homePnerd)}">${game.homePnerd.toFixed(1)}</span>
          </div>
        </div>
        <div class="tnerd-row">
          <div class="tnerd-item">
            <span>${game.awayTeamAbbr} tNERD:</span>
            <span class="tnerd-value">${game.awayTnerd.toFixed(1)}</span>
          </div>
          <div class="tnerd-item">
            <span>${game.homeTeamAbbr} tNERD:</span>
            <span class="tnerd-value">${game.homeTnerd.toFixed(1)}</span>
          </div>
        </div>
        ${flagsHtml ? `<div class="flags">${flagsHtml}</div>` : ''}
      </div>
    </article>`;
}

function setStatus(msg) {
  document.getElementById('loading').textContent = msg;
  document.getElementById('loading').classList.remove('hidden');
}

function showError(msg) {
  document.getElementById('loading').classList.add('hidden');
  const el = document.getElementById('error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Main data pipeline
// ---------------------------------------------------------------------------

async function loadGames(date) {
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('error').classList.add('hidden');
  document.getElementById('no-games').classList.add('hidden');
  document.getElementById('cards').innerHTML = '';
  document.getElementById('date-display').textContent = formatDisplayDate(date);

  const season  = parseInt(date.slice(0, 4));
  // Exclude the game day itself so scores reflect pre-game stats only.
  const endDate = shiftDate(date, -1);
  const gameMonth     = parseInt(date.slice(5, 7));
  const isEarlySeason = gameMonth <= 4;
  const statsYear     = isEarlySeason ? season - 1 : season;

  try {
    setStatus('Fetching schedule…');

    // pNERD scores come from the shared loader (same population + scores as
    // the pitchers page). tNERD data is fetched separately since it needs
    // standings and hitting stats for the correct season.
    const tNerdSeason = statsYear; // both use prior year during early season
    const [schedule, { pnerds, flags: pnerdFlags }, hittingSaber, standings, hittingPA] = await Promise.all([
      getSchedule(date),
      loadAllPnerds(statsYear, endDate),
      getHittingSabermetrics(tNerdSeason, isEarlySeason ? null : endDate),
      getStandings(tNerdSeason, isEarlySeason ? null : endDate),
      getHittingSeasonStats(tNerdSeason, isEarlySeason ? null : endDate),
    ]);

    // Merge plate appearances and strikeouts into hittingSaber for tNERD.
    for (const [pid, { pa, so }] of Object.entries(hittingPA)) {
      if (hittingSaber[pid]) {
        hittingSaber[pid].pa = pa;
        hittingSaber[pid].so = so;
      }
    }

    if (!schedule.length) {
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('no-games').classList.remove('hidden');
      return;
    }

    // Tag all pitchers with prior_year_stats during early season.
    const flags = { ...pnerdFlags };
    if (isEarlySeason) {
      for (const pid of Object.keys(pnerds)) {
        if (!flags[pid]) flags[pid] = [];
        if (!flags[pid].includes('prior_year_stats')) flags[pid].push('prior_year_stats');
      }
    }

    setStatus('Computing scores…');
    const { tnerds } = computeAllTnerds(standings, hittingSaber);

    // Assemble game results
    const results = schedule.map(g => {
      const homePnerd = round2(pnerds[g.homePitcherId] ?? 5.0);
      const awayPnerd = round2(pnerds[g.awayPitcherId] ?? 5.0);
      const homeTnerd = round2(tnerds[g.homeTeamId] ?? 5.0);
      const awayTnerd = round2(tnerds[g.awayTeamId] ?? 5.0);
      const { gameNerd, pitcherComponent, teamComponent } = computeGameNerd(awayPnerd, homePnerd, awayTnerd, homeTnerd);

      const gameFlags = [];
      if (!g.homePitcherId || !g.awayPitcherId) gameFlags.push('TBD_starter');
      for (const pid of [g.homePitcherId, g.awayPitcherId]) {
        if (!pid) continue;
        for (const f of flags[pid] || []) {
          if (!gameFlags.includes(f)) gameFlags.push(f);
        }
      }

      return {
        ...g,
        homePnerd, awayPnerd, homeTnerd, awayTnerd,
        pitcherComponent, teamComponent, gameNerd,
        flags: gameFlags,
      };
    });

    results.sort((a, b) => b.gameNerd - a.gameNerd);

    document.getElementById('loading').classList.add('hidden');
    document.getElementById('cards').innerHTML = results.map(renderCard).join('');

  } catch (err) {
    showError(`Failed to load: ${err.message}`);
    console.error(err);
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Cache busting — clears all entries related to a given date + season
// ---------------------------------------------------------------------------

function bustCacheForDate(date) {
  const season = parseInt(date.slice(0, 4));
  // Match both bare keys (e.g. nerd__pitcher_season_2026) and date-scoped keys
  // (e.g. nerd__pitcher_season_2026_thru_YYYY-MM-DD) by using prefix + underscore check.
  const prefixes = [
    `nerd__schedule_${date}`,
    `nerd__pitcher_season_${season}`,
    `nerd__pitcher_saber_${season}`,
    `nerd__hitting_saber_${season}`,
    `nerd__standings_${season}`,
    `nerd__pitcher_season_${season - 1}`,
    `nerd__pitcher_saber_${season - 1}`,
    `nerd__pnerds_all_${season}`,
    `nerd__pnerds_all_${season - 1}`,
    `nerd__pnerds_all_v2_${season}`,
    `nerd__pnerds_all_v2_${season - 1}`,
  ];
  for (const k of Object.keys(localStorage)) {
    if (prefixes.some(p => k === p || k.startsWith(p + '_'))) {
      localStorage.removeItem(k);
    } else if (k.startsWith('nerd__pitchdata_') && (k.includes(`_${season}_`) || k.includes(`_${season - 1}_`))) {
      localStorage.removeItem(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Date navigation + auto-refresh
// ---------------------------------------------------------------------------

let currentDate = todayISO();

document.getElementById('prev-day').addEventListener('click', () => {
  currentDate = shiftDate(currentDate, -1);
  loadGames(currentDate);
});
document.getElementById('next-day').addEventListener('click', () => {
  currentDate = shiftDate(currentDate, 1);
  loadGames(currentDate);
});

document.getElementById('refresh-btn').addEventListener('click', () => {
  const btn = document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  btn.disabled = true;
  bustCacheForDate(currentDate);
  loadGames(currentDate).finally(() => {
    btn.classList.remove('spinning');
    btn.disabled = false;
  });
});

setInterval(() => loadGames(currentDate), 5 * 60 * 1000);

loadGames(currentDate);
