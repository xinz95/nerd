'use strict';

function formatDisplayDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}

function shortTeamName(name) {
  if (!name) return name;
  if (name.endsWith('Red Sox') || name.endsWith('White Sox') || name.endsWith('Blue Jays')) {
    return name.split(' ').slice(-2).join(' ');
  }
  return name.split(' ').pop();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderCard(game) {
  const color  = nerdColor(game.gameNerd);
  const isLive = game.status === 'Live';
  const gameNum = game.gameNumber > 1 ? ` · Game ${game.gameNumber}` : '';

  const FLAG_MAP = {
    TBD_starter:       ['flag-tbd', '⚠ Starter TBD'],
    low_sample:        ['', 'small sample'],
    used_fip_fallback: ['', 'FIP used'],
    no_pitch_data:     ['', 'no pitch data'],
    insufficient_data: ['', 'limited data'],
    prior_year_stats:  ['', `${new Date().getFullYear() - 1} stats`],
  };
  const seen = new Set();
  const flagsHtml = (game.flags || [])
    .filter(f => FLAG_MAP[f] && !seen.has(f) && seen.add(f))
    .map(f => `<span class="flag ${FLAG_MAP[f][0]}">${FLAG_MAP[f][1]}</span>`)
    .join('');

  const pitcherLink = (name, pid) => {
    if (!pid) return name;
    return `<a href="${mlbPlayerUrl(name, pid)}" target="_blank" rel="noopener" class="pitcher-link">${name}</a>`;
  };

  const statLine = (s, pid) => {
    if (!pid) return '';
    if (!s) return ' <span class="pitcher-record">(season debut)</span>';
    const parts = [];
    if (s.wins != null && s.losses != null) parts.push(`${s.wins}-${s.losses}`);
    if (s.era != null) parts.push(`${s.era.toFixed(2)} ERA`);
    return parts.length ? ` <span class="pitcher-record">(${parts.join(', ')})</span>` : '';
  };

  const awayLogoUrl = mlbTeamLogoUrl(game.awayTeamId);
  const homeLogoUrl = mlbTeamLogoUrl(game.homeTeamId);
  const awayLogoHtml = awayLogoUrl ? `<img class="team-logo-card" src="${awayLogoUrl}" alt="${game.awayTeamAbbr}" loading="lazy">` : '';
  const homeLogoHtml = homeLogoUrl ? `<img class="team-logo-card" src="${homeLogoUrl}" alt="${game.homeTeamAbbr}" loading="lazy">` : '';

  const headshot = pid => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_67,q_auto:best/v1/people/${pid}/headshot/67/current`;
  const awayHeadshotHtml = game.awayPitcherId
    ? `<img class="pitcher-headshot-sm" src="${headshot(game.awayPitcherId)}" alt="${game.awayPitcherName}" loading="lazy">`
    : '<span class="pitcher-headshot-sm pitcher-headshot-placeholder"></span>';
  const homeHeadshotHtml = game.homePitcherId
    ? `<img class="pitcher-headshot-sm" src="${headshot(game.homePitcherId)}" alt="${game.homePitcherName}" loading="lazy">`
    : '<span class="pitcher-headshot-sm pitcher-headshot-placeholder"></span>';

  return `
    <article class="card">
      <div class="card-header" style="background:linear-gradient(135deg,${color}22,${color}08);border-bottom:2px solid ${color}55">
        <div class="matchup">
          <span class="matchup-team">
            <span class="matchup-team-top">${awayLogoHtml}<span>${game.awayTeamAbbr}</span></span>
            <span class="matchup-tnerd"><span class="tnerd-label">tNERD</span><span class="pnerd-badge" style="color:${nerdColor(game.awayTnerd)}">${game.awayTnerd.toFixed(1)}</span></span>
          </span>
          <span class="matchup-at">@</span>
          <span class="matchup-team">
            <span class="matchup-team-top">${homeLogoHtml}<span>${game.homeTeamAbbr}</span></span>
            <span class="matchup-tnerd"><span class="tnerd-label">tNERD</span><span class="pnerd-badge" style="color:${nerdColor(game.homeTnerd)}">${game.homeTnerd.toFixed(1)}</span></span>
          </span>
        </div>
        <div class="card-nerd-block">
          <div class="nerd-label">NERD</div>
          <div class="nerd-score" style="color:${color}">${game.gameNerd.toFixed(1)}</div>
        </div>
      </div>
      <div class="card-body">
        ${flagsHtml ? `<div class="flags">${flagsHtml}</div>` : ''}
        <div class="game-meta">
          <span>${isLive ? '<span class="status-live"></span>' : ''}${game.gameTimeET} ET${gameNum} &bull; ${shortTeamName(game.awayTeamName)} @ ${shortTeamName(game.homeTeamName)}</span>
          <a href="${mlbGamedayUrl(game.gamePk)}" target="_blank" rel="noopener" class="gameday-link">Gameday ↗</a>
        </div>
        <div class="pitchers">
          <div class="pitcher-row">
            ${awayHeadshotHtml}
            <span class="pitcher-name">${pitcherLink(game.awayPitcherName, game.awayPitcherId)}${statLine(game.awayPitcherStats, game.awayPitcherId)}</span>
            <span class="pnerd-badge" style="color:${nerdColor(game.awayPnerd)}">${game.awayPnerd.toFixed(1)}</span>
          </div>
          <div class="pitcher-row">
            ${homeHeadshotHtml}
            <span class="pitcher-name">${pitcherLink(game.homePitcherName, game.homePitcherId)}${statLine(game.homePitcherStats, game.homePitcherId)}</span>
            <span class="pnerd-badge" style="color:${nerdColor(game.homePnerd)}">${game.homePnerd.toFixed(1)}</span>
          </div>
        </div>
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
    const [schedule, { pnerds, flags: pnerdFlags }, hittingSaber, standings, hittingPA, currentSeasonStats] = await Promise.all([
      getSchedule(date),
      loadAllPnerds(statsYear, endDate),
      getHittingSabermetrics(statsYear, isEarlySeason ? null : endDate),
      getStandings(statsYear, isEarlySeason ? null : endDate),
      getHittingSeasonStats(statsYear, isEarlySeason ? null : endDate),
      getPitcherSeasonStats(season, endDate),  // always current year for W-L/ERA display
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
      const homePnerd = round2(pnerds[g.homePitcherId] ?? 7.0);
      const awayPnerd = round2(pnerds[g.awayPitcherId] ?? 7.0);
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
        homePitcherStats: currentSeasonStats?.[g.homePitcherId] ?? null,
        awayPitcherStats: currentSeasonStats?.[g.awayPitcherId] ?? null,
      };
    });

    currentResults = results;
    document.getElementById('loading').classList.add('hidden');
    renderCards();

  } catch (err) {
    showError(`Failed to load: ${err.message}`);
    console.error(err);
  }
}

function parseTimeMinutes(timeET) {
  const m = timeET.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let h = parseInt(m[1]), min = parseInt(m[2]);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

function renderCards() {
  const sorted = [...currentResults];
  if (sortMode === 'nerd') {
    sorted.sort((a, b) => b.gameNerd - a.gameNerd);
  } else {
    sorted.sort((a, b) => parseTimeMinutes(a.gameTimeET) - parseTimeMinutes(b.gameTimeET));
  }
  document.getElementById('cards').innerHTML = sorted.map(renderCard).join('');
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
    `nerd__pitcher_saber_all_${season}`,
    `nerd__hitting_saber_${season}`,
    `nerd__standings_${season}`,
    `nerd__pitcher_season_${season - 1}`,
    `nerd__pitcher_saber_all_${season - 1}`,
    `nerd__pnerds_all_`,
  ];
  for (const k of Object.keys(localStorage)) {
    if (prefixes.some(p => k === p || k.startsWith(p.endsWith('_') ? p : p + '_'))) {
      localStorage.removeItem(k);
    } else if (k.startsWith('nerd__pitchdata_') && (k.includes(`_${season}_`) || k.includes(`_${season - 1}_`))) {
      localStorage.removeItem(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Date navigation + auto-refresh
// ---------------------------------------------------------------------------

let currentDate   = todayISO();
let currentResults = [];
let sortMode      = 'nerd';

document.querySelectorAll('.filter-tab[data-sort]').forEach(btn => {
  btn.addEventListener('click', () => {
    sortMode = btn.dataset.sort;
    document.querySelectorAll('.filter-tab[data-sort]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (currentResults.length) renderCards();
  });
});

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
