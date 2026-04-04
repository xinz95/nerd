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

// Pitch quality sub-component weights (velocity + movement, sum to 1)
const PITCH_QUALITY_WEIGHTS = { velocity: 0.45, ivb: 0.35, absHb: 0.20 };

// pNERD top-level weights (sum to 1)
const PNERD_WEIGHTS = { xfip: 0.30, kPct: 0.25, bbPct: 0.20, pitchQuality: 0.25 };

/**
 * Computes pNERD scores for all pitchers.
 *
 * pitchDataMap: { playerId: { velocity, ivb, absHb } | null }
 *
 * Pitch quality is a composite z-score built from velocity, induced vertical
 * break, and absolute horizontal break — each z-scored at the league level,
 * then weighted. Missing sub-components substitute z = 0 (league average).
 */
function computeAllPnerds(seasonStats, saberStats, pitchDataMap, minIp = 5) {

  // League-level fallbacks for missing pitch sub-components
  const allPd = Object.values(pitchDataMap).filter(Boolean);
  const leagueMedVel  = median(allPd.map(d => d.velocity).filter(v => v != null)) || 93.0;
  const leagueMedIvb  = median(allPd.map(d => d.ivb).filter(v => v != null))      || 8.0;
  const leagueMedAbsHb = median(allPd.map(d => d.absHb).filter(v => v != null))   || 8.0;

  // Build qualifying rows
  const rows = {};
  for (const [pid, saber] of Object.entries(saberStats)) {
    const season = seasonStats[pid] || {};
    const ip = season.ip || 0;
    if (ip < minIp) continue;

    const xfip = saber.xfip ?? saber.fip;
    const kPct = season.kPct;
    if (xfip == null || kPct == null) continue;

    const pd = pitchDataMap[pid];
    rows[pid] = {
      xfip,
      usedFip:    saber.xfip == null,
      kPct,
      bbPct:      season.bbPct ?? 0.085,
      velocity:   pd?.velocity ?? leagueMedVel,
      ivb:        pd?.ivb      ?? leagueMedIvb,
      absHb:      pd?.absHb    ?? leagueMedAbsHb,
      noPitchData: pd == null || (pd.velocity == null && pd.ivb == null),
      ip,
      starts: season.gamesStarted || 0,
    };
  }

  const pids = Object.keys(rows);
  const pnerds     = {};
  const flags      = {};
  const components = {};

  if (pids.length === 0) {
    const allPids = new Set([...Object.keys(seasonStats), ...Object.keys(saberStats)]);
    for (const pid of allPids) { pnerds[pid] = 5.0; flags[pid] = ['insufficient_data']; }
    return { pnerds, flags, components: {} };
  }

  // Population distributions
  const xfipMu  = mean(pids.map(p => rows[p].xfip)),     xfipSig   = stdev(pids.map(p => rows[p].xfip));
  const kPctMu  = mean(pids.map(p => rows[p].kPct)),     kPctSig   = stdev(pids.map(p => rows[p].kPct));
  const bbPctMu = mean(pids.map(p => rows[p].bbPct)),    bbPctSig  = stdev(pids.map(p => rows[p].bbPct));
  const velMu   = mean(pids.map(p => rows[p].velocity)), velSig    = stdev(pids.map(p => rows[p].velocity));
  const ivbMu   = mean(pids.map(p => rows[p].ivb)),      ivbSig    = stdev(pids.map(p => rows[p].ivb));
  const absHbMu = mean(pids.map(p => rows[p].absHb)),    absHbSig  = stdev(pids.map(p => rows[p].absHb));
  const lowSamplePop = pids.length < 15;

  for (const pid of pids) {
    const r = rows[pid];
    const pidFlags = [];
    if (r.usedFip)     pidFlags.push('used_fip_fallback');
    if (r.noPitchData) pidFlags.push('no_pitch_data');
    if (r.starts < 3)  pidFlags.push('low_sample');
    if (lowSamplePop)  pidFlags.push('low_sample');

    const zXfip  = -zscore(r.xfip,  xfipMu,  xfipSig);   // inverted
    const zKPct  =  zscore(r.kPct,  kPctMu,  kPctSig);
    const zBbPct = -zscore(r.bbPct, bbPctMu, bbPctSig);   // inverted

    // Pitch quality: three sub-components, each league z-scored
    const zVel   = zscore(r.velocity, velMu,   velSig);
    const zIvb   = zscore(r.ivb,      ivbMu,   ivbSig);
    const zAbsHb = zscore(r.absHb,    absHbMu, absHbSig);
    const zPQ =
      zVel   * PITCH_QUALITY_WEIGHTS.velocity +
      zIvb   * PITCH_QUALITY_WEIGHTS.ivb +
      zAbsHb * PITCH_QUALITY_WEIGHTS.absHb;

    const compositeZ =
      zXfip  * PNERD_WEIGHTS.xfip +
      zKPct  * PNERD_WEIGHTS.kPct +
      zBbPct * PNERD_WEIGHTS.bbPct +
      zPQ    * PNERD_WEIGHTS.pitchQuality;

    pnerds[pid] = zToTen(compositeZ);
    flags[pid]  = [...new Set(pidFlags)];
    components[pid] = {
      xfip:      r.xfip,
      usedFip:   r.usedFip,
      kPct:      r.kPct,
      bbPct:     r.bbPct,
      velocity:  r.noPitchData ? null : r.velocity,
      ivb:       r.noPitchData ? null : r.ivb,
      absHb:     r.noPitchData ? null : r.absHb,
      noPitchData: r.noPitchData,
      ip:        r.ip,
      starts:    r.starts,
      // Directional z-scores: positive = good for the pNERD score
      zXfip,
      zKPct,
      zBbPct,
      zVel:   r.noPitchData ? null : zVel,
      zIvb:   r.noPitchData ? null : zIvb,
      zAbsHb: r.noPitchData ? null : zAbsHb,
      zPQ,
    };
  }

  // Fallback for pitchers not in qualified set
  const allPids = new Set([...Object.keys(seasonStats), ...Object.keys(saberStats)]);
  for (const pid of allPids) {
    if (!(pid in pnerds)) {
      pnerds[pid] = 5.0;
      flags[pid]  = ['insufficient_data'];
      components[pid] = null;
    }
  }

  return { pnerds, flags, components };
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
    const luck           = actualWinPct - pythWinPct;
    const proxyEra       = gp > 0 ? (ra / (gp * 9)) * 9 : 4.5;
    const signedRdPerGame = gp > 0 ? rd / gp : 0;
    const absRdPerGame   = Math.abs(signedRdPerGame);

    rows[tid] = {
      wrcPlus: teamMedianWrc[tid] ?? 100,
      proxyEra,
      luck,
      signedRdPerGame,
      absRdPerGame,
      wins, losses, gp,
    };
  }

  const tids       = Object.keys(rows);
  const tnerds     = {};
  const components = {};

  if (tids.length === 0) {
    for (const tid of Object.keys(standings)) tnerds[tid] = 5.0;
    return { tnerds, components: {} };
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
    components[tid] = {
      wrcPlus:         r.wrcPlus,
      proxyEra:        r.proxyEra,
      luck:            r.luck,
      signedRdPerGame: r.signedRdPerGame,
      wins:            r.wins,
      losses:          r.losses,
      gp:              r.gp,
      // Directional z-scores: positive = good for tNERD
      zWrc, zEra, zLuck, zRd,
    };
  }

  for (const tid of Object.keys(standings)) {
    if (!(tid in tnerds)) {
      tnerds[tid] = 5.0;
      components[tid] = null;
    }
  }

  return { tnerds, components };
}

// ---------------------------------------------------------------------------
// Prior-year stat blending
// ---------------------------------------------------------------------------

const BLEND_STARTS_THRESHOLD = 5; // full weight on current year once pitcher has 5 starts

/**
 * Merges prior-year and current-year pitcher stats into blended dicts ready
 * for computeAllPnerds.
 *
 * Rules:
 *  - weight = min(1, currentStarts / threshold)
 *  - blended = current * weight + prior * (1 - weight)
 *  - Pitcher with no current-year data but has prior-year data → 100% prior
 *  - Pitcher with neither → excluded (falls back to 5.0 in computeAllPnerds)
 *  - Prior-year team is irrelevant; pNERD is individual, tNERD comes from standings
 *
 * Returns { blendedSeason, blendedSaber, blendFlags }
 *   blendFlags: { playerId: flag_string | null }
 */
function blendPitcherStats(
  currentSeason, currentSaber,
  priorSeason,   priorSaber,
  threshold = BLEND_STARTS_THRESHOLD
) {
  const blendedSeason = {};
  const blendedSaber  = {};
  const blendFlags    = {};

  // Union of all player IDs across both seasons
  const allPids = new Set([
    ...Object.keys(currentSeason),
    ...Object.keys(currentSaber),
    ...Object.keys(priorSeason),
    ...Object.keys(priorSaber),
  ]);

  for (const pid of allPids) {
    const cur  = currentSeason[pid];
    const cSab = currentSaber[pid];
    const pri  = priorSeason[pid];
    const pSab = priorSaber[pid];

    const hasCurrent = cur != null || cSab != null;
    const hasPrior   = pri != null || pSab != null;

    if (!hasCurrent && !hasPrior) continue; // debut with no data at all → skip

    if (!hasPrior) {
      // Current season only (no prior MLB record — debut player)
      blendedSeason[pid] = cur || {};
      blendedSaber[pid]  = cSab || {};
      blendFlags[pid]    = null;
      continue;
    }

    const currentStarts = cur?.gamesStarted ?? 0;
    const w = Math.min(1, currentStarts / threshold); // current-year weight

    if (w >= 1) {
      // Enough current data — no blending needed
      blendedSeason[pid] = cur || {};
      blendedSaber[pid]  = cSab || {};
      blendFlags[pid]    = null;
      continue;
    }

    // Blend numeric fields
    const blendStat = (cVal, pVal) => {
      if (cVal == null && pVal == null) return null;
      if (cVal == null) return pVal;
      if (pVal == null) return cVal;
      return cVal * w + pVal * (1 - w);
    };

    blendedSeason[pid] = {
      era:          blendStat(cur?.era,          pri?.era),
      whip:         blendStat(cur?.whip,         pri?.whip),
      hr9:          blendStat(cur?.hr9,          pri?.hr9),
      // Use current-year IP for qualifying threshold; add prior as context
      ip:           (cur?.ip ?? 0) + (pri?.ip ?? 0) * (1 - w),
      gamesStarted: cur?.gamesStarted ?? 0,
      teamId:       cur?.teamId   ?? null, // always use current team
      name:         cur?.name     ?? pri?.name     ?? null,
      teamAbbr:     cur?.teamAbbr ?? pri?.teamAbbr ?? null,
      teamName:     cur?.teamName ?? pri?.teamName ?? null,
      kPct:  blendStat(cur?.kPct,  pri?.kPct),
      bbPct: blendStat(cur?.bbPct, pri?.bbPct),
    };

    blendedSaber[pid] = {
      fip:      blendStat(cSab?.fip,      pSab?.fip),
      xfip:     blendStat(cSab?.xfip,     pSab?.xfip),
      fipMinus: blendStat(cSab?.fipMinus, pSab?.fipMinus),
      war:      blendStat(cSab?.war,      pSab?.war),
    };

    blendFlags[pid] = w === 0 ? 'prior_year_stats' : 'blended_stats';
  }

  return { blendedSeason, blendedSaber, blendFlags };
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
