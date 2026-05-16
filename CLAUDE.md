# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Script versioning (browser cache busting)

Every JS file in `docs/` is loaded with a `?v=N` query string in the HTML files.
**Always bump the version number when modifying a JS file**, or browsers will serve the stale cached version.

Rules:
- Bump the `?v=` for every JS file you modify in a commit.
- `pnerd-loader.js` is referenced by **both** `index.html` and `pitchers.html` — bump it in both.
- `utils.js` is also on all pages — bump it in `index.html`, `pitchers.html`, and `teams.html`.
- Increment by 1 (e.g. `v=8` → `v=9`). Never reuse a version number for changed content.

## Running the project

**Static frontend (active, recommended):**
```bash
cd docs && python3 -m http.server 8080
# open http://localhost:8080
```
No build step. No dependencies. Works by opening `docs/index.html` directly in a browser.

**FastAPI backend (older implementation):**
```bash
pip install -r requirements.txt
uvicorn backend.main:app --reload
# open http://localhost:8000
```

## Two implementations — important

This repo contains two separate, diverged implementations of the same app:

| | `docs/` | `backend/` + `frontend/` |
|---|---|---|
| Language | Vanilla JS (browser) | Python (FastAPI) + HTML |
| Calls MLB API | Directly from browser | Server-side via `httpx` |
| Cache | `localStorage` (TTL-based) | `.cache/*.json` files (TTL-based) |
| pNERD formula | K%-BB%, pitch quality (velocity + whiff rate) | K/9, BB/9, velocity only |
| Deployed? | Yes (static host) | No |

**`docs/` is the canonical version.** The Python backend predates the formula upgrades and has not been kept in sync. If updating the NERD formula, `docs/nerd.js` is the source of truth; `backend/nerd_calc.py` is stale.

## Architecture

### `docs/` (static frontend)

Pages and their JS files (loaded via `<script>` tags, all versioned with `?v=N` to bust browser cache):

**`index.html`** — Daily game cards, loads `utils.js`, `mlb.js`, `nerd.js`, `pnerd-loader.js`, `app.js`
**`pitchers.html`** — Pitcher NERD list with component breakdown + headshots, loads `utils.js`, `mlb.js`, `nerd.js`, `pnerd-loader.js`, `pitchers.js`
**`teams.html`** — Team NERD list with component breakdown, loads `utils.js`, `mlb.js`, `nerd.js`, `teams.js`

- **`utils.js`** — Shared utilities loaded first on all pages: `todayISO`, `shiftDate`, `nerdColor` (red→yellow→green score coloring), `zStyle` (green/red cell coloring from z-scores).

- **`mlb.js`** — All MLB Stats API calls + `localStorage` caching. Key functions: `getSchedule`, `getPitcherSeasonStats`, `getPitcherSabermetrics`, `getHittingSabermetrics`, `getHittingSeasonStats`, `getStandings`, `getPitcherPitchDataParallel`. Pitch quality data (velocity, IVB, horizontal break, spin rate, whiff rate) is extracted from play-by-play for each pitcher's last 5 starts. All season stats calls accept an `endDate` param (cache key includes `_thru_${endDate}`) so today's game never contaminates pre-game scores. `getHittingSabermetrics` passes `playerPool: 'All'`; its cache key is `hitting_saber_all_*`. `getHittingSeasonStats` fetches plate appearances per player for PA-weighted wRC+ computation; its cache key is `hitting_season_pa_*`. Also exports `mlbPlayerUrl`, `mlbTeamUrl`, `mlbTeamLogoUrl`, `mlbGamedayUrl` helpers and a `TEAM_SLUGS` lookup (teamId → slug).

- **`nerd.js`** — Pure computation, no I/O. `computeAllPnerds(seasonStats, saberStats, pitchDataMap, minIp)` returns `{ pnerds, flags, components }`. `computeAllTnerds(standings, hittingSaber)` returns `{ tnerds, components }`. `computeGameNerd(...)`. `blendPitcherStats(...)` exists but is no longer called by the app (superseded by the date-based early-season logic).

- **`pnerd-loader.js`** — Shared loader that fetches all data needed for pNERD and calls `computeAllPnerds`. Used by both `app.js` and `pitchers.js` so the qualifying population and scores are identical across pages. Cache key includes GS threshold for auto-invalidation.

- **`app.js`** — Orchestration, rendering, date nav, cache busting. `loadGames(date)` is the main pipeline: fetch all data → use prior-year stats if March/April → fetch pitch data for ALL qualifying starters (not just today's probable starters, so pNERD z-scores are normalized over the same population as the pitcher list page) → compute scores → render sorted cards.

- **`pitchers.js`** — Pitcher list page orchestration. Fetches season stats + sabermetrics + upcoming 14-day schedules (for current-team accuracy), uses prior-year stats if March/April, fetches pitch data, renders sortable table with headshots and MLB.com links. The 14-day schedule window overrides team assignment so traded/signed players show their current team.

- **`teams.js`** — Team list page orchestration. Fetches standings + hitting sabermetrics + hitting season stats (for PA), merges PA into sabermetrics before calling `computeAllTnerds`, renders sortable table with team logos and MLB.com links.

- **`theme.js`** — Loaded in `<head>` on all pages (before paint). Reads `nerd__theme` from localStorage and sets `data-theme` on `<html>`. Wires up the `#theme-btn` toggle.

### pNERD formula (`docs/nerd.js`)

All components z-scored across qualifying pitchers (min 10 GS), clipped to ±2σ and mapped to 0–10 via `zToTen`:

| Component | Weight | Notes |
|---|---|---|
| xFIP (inverted) | 30% | Falls back to FIP; flagged with `*`. If neither available, z = 0 (neutral) |
| K%-BB% | 40% | `(strikeOuts - baseOnBalls) / battersFaced` |
| Pitch quality | 30% | Composite: velocity×0.50 + whiffRate×0.50 |

`zKPct` and `zBbPct` are still computed separately and stored in `components` for display coloring on the pitchers page, but do not contribute to the pNERD score. IVB, |HB|, and spin efficiency are also display-only. Pitch quality sub-components are z-scored at the league level before combining. Missing sub-components substitute league median (z = 0).

Qualifying pool is driven by `seasonStats` (not `saberStats`), so a sparse sabermetrics API response never collapses the pool to zero. xFIP is optional — pitchers without it contribute z = 0 for that component. Population mean/stdev for xFIP are computed over non-null values only.

Early-season handling: during March and April (month ≤ 4), prior-year stats are used wholesale for both pNERD and tNERD — no blending. May 1 onward switches to current-year stats. Pitchers flagged with `prior_year_stats` badge on game cards.

### tNERD formula

PA-weighted mean wRC+ (35%) + proxy ERA inverted (30%) + Pythagorean luck inverted (20%) + abs run differential per game inverted (15%). All components clipped to ±2σ via `zToTen`. wRC+ is weighted by plate appearances so full-time regulars drive the team score (minimum 10 PA per player to be included).

### Game NERD

`avg(pNERDs) × 0.6 + avg(tNERDs) × 0.4`, clipped to [0, 10].

### `backend/` (Python, stale)

- `mlb_client.py` — synchronous `httpx` calls, file cache in `.cache/`
- `nerd_calc.py` — old formula (K/9, BB/9, velocity)
- `main.py` — FastAPI app; warms caches on startup; 120s in-memory response cache on top of file cache
- `models.py` — Pydantic response models

## Cache key conventions (`docs/mlb.js`)

All `localStorage` keys are prefixed `nerd__`. Season-level data (pitcher stats, sabermetrics, standings) uses 1-hour TTL. Play-by-play is cached 24 hours. Pitch data per pitcher: `nerd__pitchdata_{playerId}_{season}_{nGames}_thru_{beforeDate}`. Season stats keys include a date suffix when an `endDate` is passed: e.g. `nerd__pitcher_season_2026_thru_2026-04-03`. Hitting sabermetrics key: `nerd__hitting_saber_all_{season}` (the `_all_` segment reflects `playerPool: 'All'`). The refresh button calls `bustCacheForDate()` which clears schedule, current and prior season stats, and all `pitchdata` keys using prefix matching (`startsWith`).
