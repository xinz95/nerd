'use strict';

const MLB_BASE = 'https://statsapi.mlb.com/api/v1';
const FASTBALL_CODES = new Set(['FF', 'FT', 'SI', 'FC']);

// MLB.com URL slugs keyed by team ID
const TEAM_SLUGS = {
  108: 'angels',      109: 'dbacks',     110: 'orioles',
  111: 'red-sox',     112: 'cubs',       113: 'reds',
  114: 'guardians',   115: 'rockies',    116: 'tigers',
  117: 'astros',      118: 'royals',     119: 'dodgers',
  120: 'nationals',   121: 'mets',       133: 'athletics',
  134: 'pirates',     135: 'padres',     136: 'mariners',
  137: 'giants',      138: 'cardinals',  139: 'rays',
  140: 'rangers',     141: 'blue-jays',  142: 'twins',
  143: 'phillies',    144: 'braves',     145: 'white-sox',
  146: 'marlins',     147: 'yankees',    158: 'brewers',
};

// Official MLB abbreviations keyed by team ID
const TEAM_ABBR = {
  108: 'LAA', 109: 'ARI', 110: 'BAL', 111: 'BOS', 112: 'CHC', 113: 'CIN',
  114: 'CLE', 115: 'COL', 116: 'DET', 117: 'HOU', 118: 'KC',  119: 'LAD',
  120: 'WSH', 121: 'NYM', 133: 'OAK', 134: 'PIT', 135: 'SD',  136: 'SEA',
  137: 'SF',  138: 'STL', 139: 'TB',  140: 'TEX', 141: 'TOR', 142: 'MIN',
  143: 'PHI', 144: 'ATL', 145: 'CWS', 146: 'MIA', 147: 'NYY', 158: 'MIL',
};

// ESPN abbreviations keyed by team ID (for logo CDN)
const TEAM_ESPN = {
  108: 'laa', 109: 'ari', 110: 'bal', 111: 'bos', 112: 'chc', 113: 'cin',
  114: 'cle', 115: 'col', 116: 'det', 117: 'hou', 118: 'kc',  119: 'lad',
  120: 'wsh', 121: 'nym', 133: 'oak', 134: 'pit', 135: 'sd',  136: 'sea',
  137: 'sf',  138: 'stl', 139: 'tb',  140: 'tex', 141: 'tor', 142: 'min',
  143: 'phi', 144: 'atl', 145: 'cws', 146: 'mia', 147: 'nyy', 158: 'mil',
};

function mlbPlayerUrl(name, playerId) {
  const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://www.mlb.com/player/${slug}-${playerId}`;
}

function mlbTeamUrl(teamId) {
  const slug = TEAM_SLUGS[teamId];
  return slug ? `https://www.mlb.com/${slug}` : null;
}

function mlbTeamLogoUrl(teamId) {
  const abbr = TEAM_ESPN[teamId];
  return abbr ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/mlb/500/${abbr}.png&w=56&h=56` : null;
}

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
        homeTeamAbbr: home.abbreviation || TEAM_ABBR[home.id] || '',
        awayTeamId: away.id,
        awayTeamName: away.name || '',
        awayTeamAbbr: away.abbreviation || TEAM_ABBR[away.id] || '',
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

async function getPitcherSeasonStats(season, endDate = null) {
  const key    = `pitcher_season_v2_${season}${endDate ? `_thru_${endDate}` : ''}`;
  const params = { stats: 'season', group: 'pitching', season, sportId: 1, gameType: 'R', limit: 2000 };
  if (endDate) params.endDate = endDate;
  const raw = await cached(key, 3600, () => mlbFetch('/stats', params));

  const result = {};
  for (const split of raw.stats?.[0]?.splits || []) {
    const pid = split.player?.id;
    if (!pid) continue;
    const s = split.stat || {};
    const bf = parseInt(s.battersFaced) || 0;
    const so = parseInt(s.strikeOuts) || 0;
    const bb = parseInt(s.baseOnBalls) || 0;
    result[pid] = {
      era: parseFloat(s.era) || null,
      whip: parseFloat(s.whip) || null,
      kPct:  bf > 0 ? so / bf : null,
      bbPct: bf > 0 ? bb / bf : null,
      hr9: parseFloat(s.homeRunsPer9) || null,
      ip: parseFloat(s.inningsPitched) || 0,
      gamesStarted: parseInt(s.gamesStarted) || 0,
      gamesPlayed:  parseInt(s.gamesPlayed)  || 0,
      teamId: split.team?.id || null,
      name:     split.player?.fullName   || null,
      teamAbbr: split.team?.abbreviation || TEAM_ABBR[split.team?.id] || null,
      teamName: split.team?.name         || null,
    };
  }
  return result;
}

async function getPitcherSabermetrics(season, endDate = null) {
  const key    = `pitcher_saber_${season}${endDate ? `_thru_${endDate}` : ''}`;
  const params = { stats: 'sabermetrics', group: 'pitching', season, sportId: 1, limit: 2000 };
  if (endDate) params.endDate = endDate;
  const raw = await cached(key, 3600, () => mlbFetch('/stats', params));

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

async function getHittingSabermetrics(season, endDate = null) {
  const key    = `hitting_saber_all_${season}${endDate ? `_thru_${endDate}` : ''}`;
  const params = { stats: 'sabermetrics', group: 'hitting', season, sportId: 1, limit: 2000, playerPool: 'All' };
  if (endDate) params.endDate = endDate;
  const raw = await cached(key, 3600, () => mlbFetch('/stats', params));

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
      pa: 0, // filled in by getHittingSeasonStats
    };
  }
  return result;
}

// Returns { playerId: plateAppearances } from the season hitting stats endpoint,
// which reliably includes plateAppearances unlike the sabermetrics endpoint.
async function getHittingSeasonStats(season, endDate = null) {
  const key    = `hitting_season_pa_${season}${endDate ? `_thru_${endDate}` : ''}`;
  const params = { stats: 'season', group: 'hitting', season, sportId: 1, limit: 2000, playerPool: 'All', gameType: 'R' };
  if (endDate) params.endDate = endDate;
  const raw = await cached(key, 3600, () => mlbFetch('/stats', params));

  const result = {};
  for (const split of raw.stats?.[0]?.splits || []) {
    const pid = split.player?.id;
    if (!pid) continue;
    result[pid] = {
      pa: parseInt(split.stat?.plateAppearances) || 0,
      so: parseInt(split.stat?.strikeOuts) || 0,
    };
  }
  return result;
}

async function getStandings(season, endDate = null) {
  const key    = `standings_${season}${endDate ? `_thru_${endDate}` : ''}`;
  const params = { leagueId: '103,104', season };
  if (endDate) params.date = endDate; // standings endpoint uses 'date' not 'endDate'
  const raw = await cached(key, 1800, () => mlbFetch('/standings', params));

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
        name: tr.team?.name || null,
        abbr: tr.team?.abbreviation || null,
      };
    }
  }
  return result;
}

async function getPlayerGameLog(playerId, season, beforeDate = null) {
  // Always cache the full season game log; date filtering is applied in-memory.
  const raw = await cached(`gamelog_${playerId}_${season}`, 3600, () =>
    mlbFetch(`/people/${playerId}/stats`, { stats: 'gameLog', group: 'pitching', season })
  );

  const gamePks = [];
  for (const group of raw.stats || []) {
    for (const split of group.splits || []) {
      // Exclude games on or after beforeDate so today's start is never included.
      if (beforeDate && split.date && split.date >= beforeDate) continue;
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

/**
 * Returns pitch quality components for a pitcher from their last nGames starts:
 *   { velocity, ivb, absHb }
 *   velocity — avg fastball speed (mph)
 *   ivb      — avg induced vertical break (inches, positive = rise)
 *   absHb    — avg absolute horizontal break (inches)
 * Any component may be null if insufficient data.
 */
async function getPitcherPitchData(playerId, season, nGames = 5, beforeDate = null) {
  const cacheKey = `pitchdata_${playerId}_${season}_${nGames}${beforeDate ? `_thru_${beforeDate}` : ''}`;
  const hit = lsGet(cacheKey, 3600);
  if (hit !== null) return hit;

  const gamePks = await getPlayerGameLog(playerId, season, beforeDate);
  if (!gamePks.length) {
    const empty = { velocity: null, ivb: null, absHb: null };
    lsSet(cacheKey, empty);
    return empty;
  }

  const recentPks = gamePks.slice(0, nGames);
  const pbpResults = await Promise.allSettled(recentPks.map(gp => getPlayByPlay(gp)));

  const speeds = [], ivbs = [], hbs = [], spinRates = [];

  for (const result of pbpResults) {
    if (result.status !== 'fulfilled') continue;
    for (const play of result.value.allPlays || []) {
      if (play.matchup?.pitcher?.id !== playerId) continue;
      for (const event of play.playEvents || []) {
        if (!event.isPitch) continue;
        const code = event.details?.type?.code || '';
        if (!FASTBALL_CODES.has(code)) continue;
        const pd = event.pitchData || {};
        if (pd.startSpeed)             speeds.push(parseFloat(pd.startSpeed));
        if (pd.breaks?.breakVerticalInduced != null) ivbs.push(parseFloat(pd.breaks.breakVerticalInduced));
        if (pd.breaks?.breakHorizontal != null)      hbs.push(Math.abs(parseFloat(pd.breaks.breakHorizontal)));
        if (pd.breaks?.spinRate != null)             spinRates.push(parseFloat(pd.breaks.spinRate));
      }
    }
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const data = { velocity: avg(speeds), ivb: avg(ivbs), absHb: avg(hbs), spinRate: avg(spinRates) };
  lsSet(cacheKey, data);
  return data;
}

async function getPitcherPitchDataParallel(pitcherIds, season, beforeDate = null) {
  const results = await Promise.allSettled(
    pitcherIds.map(pid => getPitcherPitchData(pid, season, 5, beforeDate))
  );
  const map = {};
  pitcherIds.forEach((pid, i) => {
    map[pid] = results[i].status === 'fulfilled' ? results[i].value : null;
  });
  return map;
}
