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
  const clipped = Math.max(-2, Math.min(2, z));
  return 5.0 + (clipped / 2) * 5;
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

// Pitch quality sub-component weights (velocity + whiff rate, sum to 1)
const PITCH_QUALITY_WEIGHTS = { velocity: 0.50, whiffRate: 0.50 };

// pNERD top-level weights (sum to 1)
const PNERD_WEIGHTS = { xfip: 0.30, kMinusBb: 0.40, pitchQuality: 0.30 };

/**
 * Computes pNERD scores for all pitchers.
 *
 * pitchDataMap: { playerId: { velocity, ivb, absHb, spinRate, whiffRate } | null }
 *
 * Pitch quality is a composite z-score built from velocity and whiff rate,
 * each z-scored at the league level then weighted. IVB, |HB|, and spin
 * efficiency are retained in components for display only.
 * Missing sub-components substitute league median (z = 0).
 */
function computeAllPnerds(seasonStats, saberStats, pitchDataMap, minIp = 5) {

  // League-level fallbacks for missing pitch sub-components
  const allPd = Object.values(pitchDataMap).filter(Boolean);
  const leagueMedVel    = median(allPd.map(d => d.velocity).filter(v => v != null))   || 93.0;
  const leagueMedIvb    = median(allPd.map(d => d.ivb).filter(v => v != null))        || 8.0;
  const leagueMedAbsHb  = median(allPd.map(d => d.absHb).filter(v => v != null))      || 8.0;
  const leagueMedSpin   = median(allPd.map(d => d.spinRate).filter(v => v != null))   || 2300;
  const leagueMedWhiff  = median(allPd.map(d => d.whiffRate).filter(v => v != null))  || 0.24;

  function calcSpinEff(ivb, absHb, spinRate) {
    if (!spinRate) return null;
    return Math.sqrt(ivb ** 2 + absHb ** 2) / (spinRate / 1000);
  }
  const leagueMedSpinEff = median(
    allPd.map(d => calcSpinEff(d.ivb ?? leagueMedIvb, d.absHb ?? leagueMedAbsHb, d.spinRate ?? leagueMedSpin)).filter(v => v != null)
  ) || 8.0;

  // Build qualifying rows — driven by seasonStats so a sparse sabermetrics
  // response never collapses the entire qualifying pool to zero.
  const rows = {};
  for (const [pid, season] of Object.entries(seasonStats)) {
    const ip   = season.ip || 0;
    if (ip < minIp) continue;

    const kPct = season.kPct;
    if (kPct == null) continue;   // must have rate stats

    const saber = saberStats[pid] || {};
    const xfip  = saber.xfip ?? saber.fip ?? null;  // optional — null → z treated as 0

    const pd = pitchDataMap[pid];
    const vel      = pd?.velocity  ?? leagueMedVel;
    const ivb      = pd?.ivb       ?? leagueMedIvb;
    const absHb    = pd?.absHb     ?? leagueMedAbsHb;
    const spin     = pd?.spinRate  ?? leagueMedSpin;
    const whiff    = pd?.whiffRate ?? leagueMedWhiff;
    const bbPct    = season.bbPct ?? 0.085;
    rows[pid] = {
      xfip,
      usedFip:     saber.xfip == null && saber.fip != null,
      kPct,
      bbPct,
      kMinusBb:    kPct - bbPct,
      velocity:    vel,
      ivb,
      absHb,
      spinRate:    spin,
      spinEff:     calcSpinEff(ivb, absHb, spin) ?? leagueMedSpinEff,
      whiffRate:   whiff,
      noPitchData: pd == null || (pd.velocity == null && pd.whiffRate == null),
      ip,
      starts:      season.gamesStarted || 0,
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

  // Population distributions — filter nulls for xFIP since it's optional
  const xfipVals   = pids.map(p => rows[p].xfip).filter(v => v != null);
  const xfipMu     = xfipVals.length ? mean(xfipVals) : 4.0;
  const xfipSig    = xfipVals.length >= 2 ? stdev(xfipVals) : 1.0;
  const kPctMu    = mean(pids.map(p => rows[p].kPct)),       kPctSig    = stdev(pids.map(p => rows[p].kPct));
  const bbPctMu   = mean(pids.map(p => rows[p].bbPct)),      bbPctSig   = stdev(pids.map(p => rows[p].bbPct));
  const kMinusBbMu = mean(pids.map(p => rows[p].kMinusBb)), kMinusBbSig = stdev(pids.map(p => rows[p].kMinusBb));
  const velMu     = mean(pids.map(p => rows[p].velocity)),   velSig     = stdev(pids.map(p => rows[p].velocity));
  const whiffMu   = mean(pids.map(p => rows[p].whiffRate)),  whiffSig   = stdev(pids.map(p => rows[p].whiffRate));
  // Display-only distributions (IVB, |HB|, spin efficiency — not in pNERD formula)
  const ivbMu     = mean(pids.map(p => rows[p].ivb)),        ivbSig     = stdev(pids.map(p => rows[p].ivb));
  const absHbMu   = mean(pids.map(p => rows[p].absHb)),      absHbSig   = stdev(pids.map(p => rows[p].absHb));
  const spinEffMu = mean(pids.map(p => rows[p].spinEff)),    spinEffSig = stdev(pids.map(p => rows[p].spinEff));
  const lowSamplePop = pids.length < 15;

  // First pass: compute component z-scores and raw composite for each pitcher.
  const rawComposites = {};
  const perPitcher    = {};
  for (const pid of pids) {
    const r = rows[pid];
    const pidFlags = [];
    if (r.usedFip)     pidFlags.push('used_fip_fallback');
    if (r.noPitchData) pidFlags.push('no_pitch_data');
    if (r.starts < 3)  pidFlags.push('low_sample');
    if (lowSamplePop)  pidFlags.push('low_sample');

    const zXfip    = r.xfip != null ? -zscore(r.xfip, xfipMu, xfipSig) : 0;  // inverted; 0 = neutral when missing
    const zKMinusBb = zscore(r.kMinusBb, kMinusBbMu, kMinusBbSig);  // higher K%-BB% = better
    // Display-only: individual K% and BB% z-scores for column coloring
    const zKPct  =  zscore(r.kPct,  kPctMu,  kPctSig);
    const zBbPct = -zscore(r.bbPct, bbPctMu, bbPctSig);  // inverted for display (green = low BB%)

    // Pitch quality formula: velocity + whiff rate
    const zVel   = zscore(r.velocity,  velMu,   velSig);
    const zWhiff = zscore(r.whiffRate, whiffMu, whiffSig);
    const zPQ    = zVel * PITCH_QUALITY_WEIGHTS.velocity + zWhiff * PITCH_QUALITY_WEIGHTS.whiffRate;

    // Display-only z-scores (not in formula)
    const zIvb     = zscore(r.ivb,     ivbMu,     ivbSig);
    const zAbsHb   = zscore(r.absHb,   absHbMu,   absHbSig);
    const zSpinEff = zscore(r.spinEff, spinEffMu, spinEffSig);

    rawComposites[pid] =
      zXfip    * PNERD_WEIGHTS.xfip +
      zKMinusBb * PNERD_WEIGHTS.kMinusBb +
      zPQ      * PNERD_WEIGHTS.pitchQuality;

    perPitcher[pid] = { r, pidFlags, zXfip, zKMinusBb, zKPct, zBbPct, zVel, zWhiff, zIvb, zAbsHb, zSpinEff, zPQ };
  }

  // Second pass: re-normalize composite z-scores across the population so scores
  // always spread across the full 0–10 range rather than clustering near 5.
  const compVals = Object.values(rawComposites);
  const compMu   = mean(compVals);
  const compSig  = stdev(compVals);

  for (const pid of pids) {
    const { r, pidFlags, zXfip, zKMinusBb, zKPct, zBbPct, zVel, zWhiff, zIvb, zAbsHb, zSpinEff, zPQ } = perPitcher[pid];
    const normalizedZ = zscore(rawComposites[pid], compMu, compSig);

    pnerds[pid] = zToTen(normalizedZ);
    flags[pid]  = [...new Set(pidFlags)];
    components[pid] = {
      xfip:        r.xfip,
      usedFip:     r.usedFip,
      kPct:        r.kPct,
      bbPct:       r.bbPct,
      velocity:    r.noPitchData ? null : r.velocity,
      whiffRate:   r.noPitchData ? null : r.whiffRate,
      // Display-only (not in formula)
      ivb:         r.noPitchData ? null : r.ivb,
      absHb:       r.noPitchData ? null : r.absHb,
      spinEff:     r.noPitchData ? null : r.spinEff,
      noPitchData: r.noPitchData,
      ip:          r.ip,
      starts:      r.starts,
      zXfip,
      zKMinusBb,
      // Display-only z-scores for column coloring (not in formula)
      zKPct,
      zBbPct,
      zVel:        r.noPitchData ? null : zVel,
      zWhiff:      r.noPitchData ? null : zWhiff,
      // Display-only z-scores (for column coloring)
      zIvb:        r.noPitchData ? null : zIvb,
      zAbsHb:      r.noPitchData ? null : zAbsHb,
      zSpinEff:    r.noPitchData ? null : zSpinEff,
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

const TNERD_WEIGHTS = { wrcPlus: 0.30, proxyEra: 0.125, bullpenEra: 0.125, luck: 0.20, absDiff: 0.15, kPct: 0.10 };

function computeAllTnerds(standings, hittingSaber, bullpenEra = {}, minGames = 3) {
  // Aggregate PA-weighted mean wRC+ and team K% per team.
  // Weighting by plate appearances ensures that full-time regulars drive the
  // team score rather than bench players or call-ups with a handful of PAs.
  const teamWrcAcc = {}; // { teamId: { weightedSum, totalPa } }
  const teamKAcc   = {}; // { teamId: { totalSo, totalPa } }
  for (const h of Object.values(hittingSaber)) {
    const { teamId, wrcPlus, pa, so } = h;
    if (!teamId || pa < 10) continue;
    if (wrcPlus != null) {
      if (!teamWrcAcc[teamId]) teamWrcAcc[teamId] = { weightedSum: 0, totalPa: 0 };
      teamWrcAcc[teamId].weightedSum += wrcPlus * pa;
      teamWrcAcc[teamId].totalPa    += pa;
    }
    if (so != null) {
      if (!teamKAcc[teamId]) teamKAcc[teamId] = { totalSo: 0, totalPa: 0 };
      teamKAcc[teamId].totalSo += so;
      teamKAcc[teamId].totalPa += pa;
    }
  }
  const teamMedianWrc = {};
  for (const [tid, { weightedSum, totalPa }] of Object.entries(teamWrcAcc)) {
    if (totalPa > 0) teamMedianWrc[tid] = weightedSum / totalPa;
  }
  const teamKPct = {};
  for (const [tid, { totalSo, totalPa }] of Object.entries(teamKAcc)) {
    if (totalPa > 0) teamKPct[tid] = totalSo / totalPa;
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
      wrcPlus:    teamMedianWrc[tid] ?? 100,
      kPct:       teamKPct[tid] ?? null,
      bullpenEra: bullpenEra[tid] ?? null,
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
  const kVals    = tids.map(t => rows[t].kPct).filter(v => v != null);
  const bpVals   = tids.map(t => rows[t].bullpenEra).filter(v => v != null);

  const wrcMu  = mean(wrcVals),  wrcSig  = stdev(wrcVals);
  const eraMu  = mean(eraVals),  eraSig  = stdev(eraVals);
  const luckMu = mean(luckVals), luckSig = stdev(luckVals);
  const rdMu   = mean(rdVals),   rdSig   = stdev(rdVals);
  const kMu    = mean(kVals),    kSig    = stdev(kVals);
  const bpMu   = mean(bpVals),   bpSig   = stdev(bpVals);

  // First pass: compute component z-scores and raw composite for each team.
  const rawComposites = {};
  const perTeam = {};
  for (const tid of tids) {
    const r = rows[tid];
    const zWrc   =  zscore(r.wrcPlus,      wrcMu,  wrcSig);
    const zEra   = -zscore(r.proxyEra,     eraMu,  eraSig);  // inverted
    const zBpEra = r.bullpenEra != null ? -zscore(r.bullpenEra, bpMu, bpSig) : 0; // inverted
    const zLuck  =  zscore(r.luck,         luckMu, luckSig); // overperforming = more interesting
    const zRd    = -zscore(r.absRdPerGame, rdMu,   rdSig);   // close games = more interesting
    const zKPct  = r.kPct != null ? -zscore(r.kPct, kMu, kSig) : 0; // inverted: low K% = more action

    rawComposites[tid] =
      zWrc   * TNERD_WEIGHTS.wrcPlus +
      zEra   * TNERD_WEIGHTS.proxyEra +
      zBpEra * TNERD_WEIGHTS.bullpenEra +
      zLuck  * TNERD_WEIGHTS.luck +
      zRd    * TNERD_WEIGHTS.absDiff +
      zKPct  * TNERD_WEIGHTS.kPct;

    perTeam[tid] = { r, zWrc, zEra, zBpEra, zLuck, zRd, zKPct };
  }

  // Second pass: re-normalize the composite z-scores across teams so scores
  // always use the full 0–10 range rather than clustering near 5.
  const compVals = Object.values(rawComposites);
  const compMu  = mean(compVals);
  const compSig = stdev(compVals);

  for (const tid of tids) {
    const { r, zWrc, zEra, zBpEra, zLuck, zRd, zKPct } = perTeam[tid];
    const normalizedZ = zscore(rawComposites[tid], compMu, compSig);

    tnerds[tid] = zToTen(normalizedZ);
    components[tid] = {
      wrcPlus:         r.wrcPlus,
      kPct:            r.kPct,
      proxyEra:        r.proxyEra,
      bullpenEra:      r.bullpenEra,
      luck:            r.luck,
      signedRdPerGame: r.signedRdPerGame,
      wins:            r.wins,
      losses:          r.losses,
      gp:              r.gp,
      // Directional z-scores: positive = good for tNERD
      zWrc, zEra, zBpEra, zLuck, zRd, zKPct,
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
