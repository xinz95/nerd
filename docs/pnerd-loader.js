'use strict';

// ---------------------------------------------------------------------------
// Shared pNERD loader
//
// Single source of truth for all pitcher pNERD scores. Both pitchers.js and
// app.js call this so the qualifying population, z-score normalization, and
// final scores are always identical across pages.
//
// Raw API responses are cached by mlb.js individually. This layer caches the
// computed pNERD result so repeated calls within the same session are instant.
// ---------------------------------------------------------------------------

// Minimum games started to be included in the pNERD z-score population.
// Value is encoded in the cache key — changing it auto-invalidates old entries.
const PNERD_MIN_GS = 10;

/**
 * Loads pNERD scores for every starter in `statsYear`.
 *
 * @param {number}      statsYear  - Season year to pull stats from (e.g. 2025)
 * @param {string|null} endDate    - ISO date upper bound for API calls.
 *                                   Ignored for completed seasons so pitchers.js
 *                                   and app.js share the same cache entry.
 * @returns {Promise<{ pnerds, flags, components, seasonStats, saberStats }>}
 */
async function loadAllPnerds(statsYear, endDate = null) {
  const currentYear = new Date().getFullYear();
  // For completed seasons the endDate doesn't change the data — normalize it
  // away so both pages hit the same cache key.
  const effectiveEnd = statsYear < currentYear ? null : endDate;

  const cacheKey = `pnerds_all_gs${PNERD_MIN_GS}_${statsYear}${effectiveEnd ? `_thru_${effectiveEnd}` : ''}`;
  const hit = lsGet(cacheKey, 3600);
  if (hit !== null) return hit;

  const [seasonStats, saberStats] = await Promise.all([
    getPitcherSeasonStats(statsYear, effectiveEnd),
    getPitcherSabermetrics(statsYear, effectiveEnd),
  ]);

  const starters = Object.entries(seasonStats).filter(([, s]) => s.gamesStarted >= PNERD_MIN_GS);
  const starterIds  = starters.map(([pid]) => Number(pid));
  const starterStats = Object.fromEntries(starters);

  const pitchDataMap = await getPitcherPitchDataParallel(starterIds, statsYear, effectiveEnd);

  const { pnerds, flags, components } = computeAllPnerds(starterStats, saberStats, pitchDataMap, 0);

  const result = { pnerds, flags, components, seasonStats, saberStats };
  lsSet(cacheKey, result);
  return result;
}
