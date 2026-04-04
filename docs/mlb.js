'use strict';

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const FASTBALL_CODES = new Set(['FF', 'FT', 'SI', 'FC']);

// ---------------------------------------------------------------------------
// localStorage cache with TTL
// ---------------------------------------------------------------------------

function lsGet(key, ttl) {
  try {
    const raw = localStorage.getItem('nerd__' + key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > ttl * 1000) return null;
    return data;
  } catch { return null; }
}

function lsSet(key, data) {
  try {
    localStorage.setItem('nerd__' + key, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // localStorage quota exceeded — clear old entries and try once more
    clearOldCache();
    try { localStorage.setItem('nerd__' + key, JSON.stringify({ ts: Date.now(), data })); } catch {}
  }
}

function clearOldCache() {
  const cutoff = Date.now() - 86400 * 1000;
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('nerd__')) continue;
    try {
      const { ts } = JSON.parse(localStorage.getItem(k));
      if (ts < cutoff) localStorage.removeItem(k);
    } catch { localStorage.removeItem(k); }
  }
}

async function cached(key, ttl, fetcher) {
  const hit = lsGet(key, ttl);
  if (hit !== null) return hit;
  const data = await fetcher();
  lsSet(key, data);
  return data;
}

// ---------------------------------------------------------------------------
// Raw fetch
// ---------------------------------------------------------------------------

async function mlbFetch(path, params = {}) {
  const url = new URL(MLB_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const resp = await fetch(url.toString());
  if (!resp.ok) throw new Error(`MLB API error ${resp.status} for ${path}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Public API functions
// ---------------------------------------------------------------------------

async function getSchedule(date) {
  const today = new Date().toISOString().slice(0, 10);
  const ttl = date >= today ? 300 : 86400;
  const raw = await cached(`schedule_${date}`, ttl, () =>
    mlbFetch('/schedule', { sportId: 1, date, hydrate: 'probablePitcher,team,linescore' })
  );

  const games = [];
  for (const dateEntry of raw.dates || []) {
    for (const g of dateEntry.games || []) {
      const detailed = g.status?.detailedState || '';
      if (detailed.includes('Postponed') || detailed.includes('Cancelled')) continue;

      const home = g.teams?.home?.team || {};
      const away = g.teams?.away?.team || {};
      const hp = g.teams?.home?.probablePitcher;
      const ap = g.teams?.away?.probablePitcher;

      games.push({
        gamePk: g.gamePk,
        gameDate: g.officialDate || date,
        gameTimeET: parseGameTimeET(g.gameDate || ''),
        gameNumber: g.gameNumber || 1,
        status: g.status?.abstractGameState || '',
        homeTeamId: home.id,
        homeTeamName: home.name || '',
        homeTeamAbbr: home.abbreviation || '',
        awayTeamId: away.id,
        awayTeamName: away.name || '',
        awayTeamAbbr: away.abbreviation || '',
        homePitcherId: hp?.id || null,
        homePitcherName: hp?.fullName || 'TBD',
        awayPitcherId: ap?.id || null,
        awayPitcherName: ap?.fullName || 'TBD',
      });
    }
  }
  return games;
}

function parseGameTimeET(iso) {
  if (!iso) return 'TBD';
  try {
    const timePart = iso.split('T')[1]?.replace('Z', '');
    if (!timePart) return 'TBD';
    let [h, m] = timePart.split(':').map(Number);
    h = h - 4; // EDT
    if (h < 0) h += 24;
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  } catch { return 'TBD'; }
}

async function getPitcherSeasonStats(season) {
  const raw = await cached(`pitcher_season_${season}`, 3600, () =>
    mlbFetch('/stats', { stats: 'season', group: 'pitching', season, sportId: 1, gameType: 'R', limit: 2000 })
  );

  const result = {};
  for (const split of raw.stats?.[0]?.splits || []) {
    const pid = split.player?.id;
    if (!pid) continue;
    const s = split.stat || {};
    result[pid] = {
      era: parseFloat(s.era) || null,
      whip: parseFloat(s.whip) || null,
      k9: parseFloat(s.strikeoutsPer9Inn) || null,
      bb9: parseFloat(s.walksPer9Inn) || null,
      hr9: parseFloat(s.homeRunsPer9) || null,
      ip: parseFloat(s.inningsPitched) || 0,
      gamesStarted: parseInt(s.gamesStarted) || 0,
      teamId: split.team?.id || null,
    };
  }
  return result;
}

async function getPitcherSabermetrics(season) {
  const raw = await cached(`pitcher_saber_${season}`, 3600, () =>
    mlbFetch('/stats', { stats: 'sabermetrics', group: 'pitching', season, sportId: 1, limit: 2000 })
  );

  const result = {};
  for (const split of raw.stats?.[0]?.splits || []) {
    const pid = split.player?.id;
    if (!pid) continue;
    const s = split.stat || {};
    result[pid] = {
      fip: parseFloat(s.fip) || null,
      xfip: parseFloat(s.xfip) || null,
      fipMinus: parseFloat(s.fipMinus) || null,
      war: parseFloat(s.war) || null,
    };
  }
  return result;
}

async function getHittingSabermetrics(season) {
  const raw = await cached(`hitting_saber_${season}`, 3600, () =>
    mlbFetch('/stats', { stats: 'sabermetrics', group: 'hitting', season, sportId: 1, limit: 2000 })
  );

  const result = {};
  for (const split of raw.stats?.[0]?.splits || []) {
    const pid = split.player?.id;
    if (!pid) continue;
    const s = split.stat || {};
    result[pid] = {
      wrcPlus: parseFloat(s.wRcPlus) || null,
      woba: parseFloat(s.woba) || null,
      war: parseFloat(s.war) || null,
      teamId: split.team?.id || null,
    };
  }
  return result;
}

async function getStandings(season) {
  const raw = await cached(`standings_${season}`, 1800, () =>
    mlbFetch('/standings', { leagueId: '103,104', season })
  );

  const result = {};
  for (const division of raw.records || []) {
    for (const tr of division.teamRecords || []) {
      const tid = tr.team?.id;
      if (!tid) continue;
      result[tid] = {
        wins: parseInt(tr.wins) || 0,
        losses: parseInt(tr.losses) || 0,
        gamesPlayed: parseInt(tr.gamesPlayed) || 0,
        winPct: parseFloat(tr.winningPercentage) || 0,
        runsScored: parseInt(tr.runsScored) || 0,
        runsAllowed: parseInt(tr.runsAllowed) || 0,
        runDifferential: parseInt(tr.runDifferential) || 0,
      };
    }
  }
  return result;
}

async function getPlayerGameLog(playerId, season) {
  const raw = await cached(`gamelog_${playerId}_${season}`, 3600, () =>
    mlbFetch(`/people/${playerId}/stats`, { stats: 'gameLog', group: 'pitching', season })
  );

  const gamePks = [];
  for (const group of raw.stats || []) {
    for (const split of group.splits || []) {
      if (parseInt(split.stat?.gamesStarted) >= 1) {
        const gp = split.game?.gamePk;
        if (gp) gamePks.push(parseInt(gp));
      }
    }
  }
  return gamePks.reverse(); // most recent first
}

async function getPlayByPlay(gamePk) {
  return cached(`pbp_${gamePk}`, 86400, () =>
    mlbFetch(`/game/${gamePk}/playByPlay`)
  );
}

async function getPitcherVelocity(playerId, season, nGames = 5) {
  const cacheKey = `velocity_${playerId}_${season}_${nGames}`;
  const cached_vel = lsGet(cacheKey, 3600);
  if (cached_vel !== null) return cached_vel.velocity;

  const gamePks = await getPlayerGameLog(playerId, season);
  if (!gamePks.length) {
    lsSet(cacheKey, { velocity: null });
    return null;
  }

  const recentPks = gamePks.slice(0, nGames);
  const pbpResults = await Promise.allSettled(recentPks.map(gp => getPlayByPlay(gp)));

  const speeds = [];
  for (const result of pbpResults) {
    if (result.status !== 'fulfilled') continue;
    const pbp = result.value;
    for (const play of pbp.allPlays || []) {
      const pitcherId = play.matchup?.pitcher?.id;
      if (pitcherId !== playerId) continue;
      for (const event of play.playEvents || []) {
        if (!event.isPitch) continue;
        const code = event.details?.type?.code || '';
        if (!FASTBALL_CODES.has(code)) continue;
        const spd = event.pitchData?.startSpeed;
        if (spd) speeds.push(parseFloat(spd));
      }
    }
  }

  const velocity = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;
  lsSet(cacheKey, { velocity });
  return velocity;
}

async function getPitcherVelocitiesParallel(pitcherIds, season) {
  const results = await Promise.allSettled(
    pitcherIds.map(pid => getPitcherVelocity(pid, season))
  );
  const map = {};
  pitcherIds.forEach((pid, i) => {
    map[pid] = results[i].status === 'fulfilled' ? results[i].value : null;
  });
  return map;
}
