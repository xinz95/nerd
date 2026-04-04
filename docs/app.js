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
    no_velocity_data:  ['', 'no velo data'],
    insufficient_data: ['', 'limited data'],
    prior_year_stats:  ['', '2025 stats'],
    blended_stats:     ['', 'blended stats'],
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

  const season = parseInt(date.slice(0, 4));

  try {
    setStatus('Fetching schedule…');
    const [schedule, seasonStats, saberStats, hittingSaber, standings] = await Promise.all([
      getSchedule(date),
      getPitcherSeasonStats(season),
      getPitcherSabermetrics(season),
      getHittingSabermetrics(season),
      getStandings(season),
    ]);

    if (!schedule.length) {
      document.getElementById('loading').classList.add('hidden');
      document.getElementById('no-games').classList.remove('hidden');
      return;
    }

    // Estimate how far into the season we are
    const gpVals = Object.values(standings).map(s => s.gamesPlayed).filter(g => g > 0);
    const avgGp = gpVals.length ? gpVals.reduce((a, b) => a + b, 0) / gpVals.length : 1;
    const minIp = Math.max(3, avgGp);

    // Blend with prior year stats for first 30 games of the season
    let effectiveSeasonStats = seasonStats;
    let effectiveSaberStats  = saberStats;
    let blendFlags            = {};

    if (avgGp < 30) {
      setStatus('Fetching prior season stats for blending…');
      const [priorSeason, priorSaber] = await Promise.all([
        getPitcherSeasonStats(season - 1),
        getPitcherSabermetrics(season - 1),
      ]);
      const blended = blendPitcherStats(seasonStats, saberStats, priorSeason, priorSaber);
      effectiveSeasonStats = blended.blendedSeason;
      effectiveSaberStats  = blended.blendedSaber;
      blendFlags            = blended.blendFlags;
    }

    setStatus(`Fetching pitcher velocity data… (this may take a moment on first load)`);

    // Fetch velocities only for today's probable pitchers
    const pitcherIds = [...new Set(
      schedule.flatMap(g => [g.homePitcherId, g.awayPitcherId]).filter(Boolean)
    )];
    let velocities = await getPitcherVelocitiesParallel(pitcherIds, season);

    // For pitchers with no current-year velocity, fall back to prior year
    if (avgGp < 30) {
      const missingVelIds = pitcherIds.filter(pid => velocities[pid] == null);
      if (missingVelIds.length > 0) {
        const priorVelocities = await getPitcherVelocitiesParallel(missingVelIds, season - 1);
        velocities = { ...velocities };
        for (const pid of missingVelIds) {
          if (priorVelocities[pid] != null) velocities[pid] = priorVelocities[pid];
        }
      }
    }

    setStatus('Computing scores…');
    const { pnerds, flags: pnerdFlags } = computeAllPnerds(effectiveSeasonStats, effectiveSaberStats, velocities, minIp);

    // Merge blend flags into pnerd flags
    const flags = { ...pnerdFlags };
    for (const [pid, bFlag] of Object.entries(blendFlags)) {
      if (!bFlag) continue;
      if (!flags[pid]) flags[pid] = [];
      if (!flags[pid].includes(bFlag)) flags[pid].push(bFlag);
    }
    const tnerds = computeAllTnerds(standings, hittingSaber);

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

setInterval(() => loadGames(currentDate), 5 * 60 * 1000);

loadGames(currentDate);
