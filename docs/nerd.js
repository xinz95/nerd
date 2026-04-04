'use strict';

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 1;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance) || 1;
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function zscore(value, mu, sigma) {
  return (value - mu) / sigma;
}

function zToTen(z) {
  const clipped = Math.max(-3, Math.min(3, z));
  return 5.0 + (clipped / 3) * 5;
}

function pythagoreanWinPct(rs, ra, exp = 1.83) {
  if (rs + ra === 0) return 0.5;
  const rsE = Math.pow(rs, exp);
  const raE = Math.pow(ra, exp);
  return rsE / (rsE + raE);
}

// ---------------------------------------------------------------------------
// Pitcher NERD
// ---------------------------------------------------------------------------

const PNERD_WEIGHTS = { xfip: 0.30, k9: 0.25, bb9: 0.20, velocity: 0.25 };

function computeAllPnerds(seasonStats, saberStats, velocities, minIp = 5) {
  const validVels = Object.values(velocities).filter(v => v !== null);
  const leagueMedianVel = validVels.length ? median(validVels) : 93.0;

  // Build qualifying rows
  const rows = {};
  for (const [pid, saber] of Object.entries(saberStats)) {
    const season = seasonStats[pid] || {};
    const ip = season.ip || 0;
    if (ip < minIp) continue;

    const xfip = saber.xfip ?? saber.fip;
    const k9 = season.k9;
    if (xfip == null || k9 == null) continue;

    rows[pid] = {
      xfip,
      usedFip: saber.xfip == null,
      k9,
      bb9: season.bb9 ?? 3.5,
      velocity: velocities[pid] ?? leagueMedianVel,
      noVelocity: velocities[pid] == null,
      ip,
      starts: season.gamesStarted || 0,
    };
  }

  const pids = Object.keys(rows);
  const pnerds = {};
  const flags = {};

  if (pids.length === 0) {
    const allPids = new Set([...Object.keys(seasonStats), ...Object.keys(saberStats)]);
    for (const pid of allPids) {
      pnerds[pid] = 5.0;
      flags[pid] = ['insufficient_data'];
    }
    return { pnerds, flags };
  }

  // Population stats
  const xfipVals = pids.map(p => rows[p].xfip);
  const k9Vals   = pids.map(p => rows[p].k9);
  const bb9Vals  = pids.map(p => rows[p].bb9);
  const velVals  = pids.map(p => rows[p].velocity);

  const xfipMu = mean(xfipVals), xfipSig = stdev(xfipVals);
  const k9Mu   = mean(k9Vals),   k9Sig   = stdev(k9Vals);
  const bb9Mu  = mean(bb9Vals),  bb9Sig  = stdev(bb9Vals);
  const velMu  = mean(velVals),  velSig  = stdev(velVals);
  const lowSamplePop = pids.length < 15;

  for (const pid of pids) {
    const r = rows[pid];
    const pidFlags = [];
    if (r.usedFip)    pidFlags.push('used_fip_fallback');
    if (r.noVelocity) pidFlags.push('no_velocity_data');
    if (r.starts < 3) pidFlags.push('low_sample');
    if (lowSamplePop) pidFlags.push('low_sample');

    const zXfip = -zscore(r.xfip, xfipMu, xfipSig); // inverted
    const zK9   =  zscore(r.k9,   k9Mu,   k9Sig);
    const zBb9  = -zscore(r.bb9,  bb9Mu,  bb9Sig);  // inverted
    const zVel  =  zscore(r.velocity, velMu, velSig);

    const compositeZ =
      zXfip * PNERD_WEIGHTS.xfip +
      zK9   * PNERD_WEIGHTS.k9 +
      zBb9  * PNERD_WEIGHTS.bb9 +
      zVel  * PNERD_WEIGHTS.velocity;

    pnerds[pid] = zToTen(compositeZ);
    flags[pid]  = [...new Set(pidFlags)];
  }

  // Fallback for pitchers not in qualified set
  const allPids = new Set([...Object.keys(seasonStats), ...Object.keys(saberStats)]);
  for (const pid of allPids) {
    if (!(pid in pnerds)) {
      pnerds[pid] = 5.0;
      flags[pid]  = ['insufficient_data'];
    }
  }

  return { pnerds, flags };
}

// ---------------------------------------------------------------------------
// Team NERD
// ---------------------------------------------------------------------------

const TNERD_WEIGHTS = { wrcPlus: 0.35, proxyEra: 0.30, luck: 0.20, absDiff: 0.15 };

function computeAllTnerds(standings, hittingSaber, minGames = 3) {
  // Aggregate median wRC+ per team
  const teamWrc = {};
  for (const h of Object.values(hittingSaber)) {
    const { teamId, wrcPlus } = h;
    if (!teamId || wrcPlus == null) continue;
    (teamWrc[teamId] = teamWrc[teamId] || []).push(wrcPlus);
  }
  const teamMedianWrc = {};
  for (const [tid, vals] of Object.entries(teamWrc)) {
    teamMedianWrc[tid] = median(vals);
  }

  const rows = {};
  for (const [tid, st] of Object.entries(standings)) {
    const gp = st.gamesPlayed;
    if (gp < minGames) continue;

    const { wins, losses, runsScored: rs, runsAllowed: ra, runDifferential: rd } = st;
    const total = wins + losses;
    const actualWinPct = total > 0 ? wins / total : 0.5;
    const pythWinPct = pythagoreanWinPct(rs, ra);
    const luck = actualWinPct - pythWinPct;
    const proxyEra = gp > 0 ? (ra / (gp * 9)) * 9 : 4.5;
    const rdPerGame = gp > 0 ? Math.abs(rd / gp) : 0;

    rows[tid] = {
      wrcPlus: teamMedianWrc[tid] ?? 100,
      proxyEra,
      luck,
      absRdPerGame: rdPerGame,
    };
  }

  const tids = Object.keys(rows);
  const tnerds = {};

  if (tids.length === 0) {
    for (const tid of Object.keys(standings)) tnerds[tid] = 5.0;
    return tnerds;
  }

  const wrcVals  = tids.map(t => rows[t].wrcPlus);
  const eraVals  = tids.map(t => rows[t].proxyEra);
  const luckVals = tids.map(t => rows[t].luck);
  const rdVals   = tids.map(t => rows[t].absRdPerGame);

  const wrcMu  = mean(wrcVals),  wrcSig  = stdev(wrcVals);
  const eraMu  = mean(eraVals),  eraSig  = stdev(eraVals);
  const luckMu = mean(luckVals), luckSig = stdev(luckVals);
  const rdMu   = mean(rdVals),   rdSig   = stdev(rdVals);

  for (const tid of tids) {
    const r = rows[tid];
    const zWrc  =  zscore(r.wrcPlus,     wrcMu,  wrcSig);
    const zEra  = -zscore(r.proxyEra,    eraMu,  eraSig);  // inverted
    const zLuck = -zscore(r.luck,        luckMu, luckSig); // overperforming = less interesting
    const zRd   = -zscore(r.absRdPerGame, rdMu,   rdSig);  // close games = more interesting

    const compositeZ =
      zWrc  * TNERD_WEIGHTS.wrcPlus +
      zEra  * TNERD_WEIGHTS.proxyEra +
      zLuck * TNERD_WEIGHTS.luck +
      zRd   * TNERD_WEIGHTS.absDiff;

    tnerds[tid] = zToTen(compositeZ);
  }

  for (const tid of Object.keys(standings)) {
    if (!(tid in tnerds)) tnerds[tid] = 5.0;
  }

  return tnerds;
}

// ---------------------------------------------------------------------------
// Game NERD
// ---------------------------------------------------------------------------

function computeGameNerd(awayPnerd, homePnerd, awayTnerd, homeTnerd) {
  const pitcherComponent = (awayPnerd + homePnerd) / 2;
  const teamComponent    = (awayTnerd + homeTnerd) / 2;
  const gameNerd = Math.max(0, Math.min(10, pitcherComponent * 0.6 + teamComponent * 0.4));
  return {
    gameNerd:         Math.round(gameNerd * 100) / 100,
    pitcherComponent: Math.round(pitcherComponent * 100) / 100,
    teamComponent:    Math.round(teamComponent * 100) / 100,
  };
}
