"""
NERD FastAPI application.

Run with: uvicorn backend.main:app --reload
"""

from __future__ import annotations

import asyncio
import sys
import time
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Ensure the repo root is on sys.path so `backend.*` imports work
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend import mlb_client, nerd_calc
from backend.models import (
    DayScheduleResponse,
    GameNERDResult,
    HealthResponse,
    ProbablePitcher,
    TeamSummary,
)

# In-memory response cache: {date_str: (timestamp, DayScheduleResponse)}
_response_cache: dict[str, tuple[float, DayScheduleResponse]] = {}
RESPONSE_CACHE_TTL = 120  # seconds


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Warm caches on startup (non-blocking)
    asyncio.create_task(_warm_caches())
    yield


app = FastAPI(title="NERD Baseball Watchability", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


async def _warm_caches():
    """Pre-fetch season-level data so the first request is fast."""
    season = date.today().year
    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, mlb_client.get_pitcher_season_stats, season)
        await loop.run_in_executor(None, mlb_client.get_pitcher_sabermetrics, season)
        await loop.run_in_executor(None, mlb_client.get_hitting_sabermetrics, season)
        await loop.run_in_executor(None, mlb_client.get_standings, season)
    except Exception as e:
        print(f"[NERD] Cache warm failed: {e}")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/api/games", response_model=DayScheduleResponse)
async def get_games(date_str: str = Query(default=None, alias="date")):
    if date_str is None:
        date_str = date.today().isoformat()

    # Validate date format
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")

    # Check in-memory response cache
    cached = _response_cache.get(date_str)
    if cached and time.time() - cached[0] < RESPONSE_CACHE_TTL:
        return cached[1]

    season = int(date_str[:4])
    loop = asyncio.get_event_loop()

    # Fetch all data concurrently using thread pool (httpx is synchronous)
    try:
        (
            schedule,
            season_stats,
            saber_stats,
            hitting_saber,
            standings,
        ) = await asyncio.gather(
            loop.run_in_executor(None, mlb_client.get_schedule, date_str),
            loop.run_in_executor(None, mlb_client.get_pitcher_season_stats, season),
            loop.run_in_executor(None, mlb_client.get_pitcher_sabermetrics, season),
            loop.run_in_executor(None, mlb_client.get_hitting_sabermetrics, season),
            loop.run_in_executor(None, mlb_client.get_standings, season),
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"MLB API unavailable: {e}")

    if not schedule:
        response = DayScheduleResponse(
            date=date_str,
            games=[],
            generated_at=datetime.utcnow().isoformat(),
            season=season,
            game_count=0,
        )
        _response_cache[date_str] = (time.time(), response)
        return response

    # Collect probable pitcher IDs (skip None / TBD)
    pitcher_ids: list[int] = []
    for g in schedule:
        if g["home_pitcher_id"]:
            pitcher_ids.append(g["home_pitcher_id"])
        if g["away_pitcher_id"]:
            pitcher_ids.append(g["away_pitcher_id"])
    pitcher_ids = list(set(pitcher_ids))

    # Fetch velocities in parallel (blocking, uses ThreadPoolExecutor internally)
    velocities: dict[int, float | None] = {}
    if pitcher_ids:
        velocities = await loop.run_in_executor(
            None,
            mlb_client.get_pitcher_velocities_parallel,
            pitcher_ids,
            season,
        )

    # Compute NERD scores
    # Dynamic min_ip based on how far into the season we are
    games_into_season = _estimate_games_into_season(standings)
    min_ip = max(3.0, float(games_into_season))

    pnerds, p_flags = nerd_calc.compute_all_pnerds(season_stats, saber_stats, velocities, min_ip)
    tnerds = nerd_calc.compute_all_tnerds(standings, hitting_saber)

    # Assemble game results
    results: list[GameNERDResult] = []
    for g in schedule:
        home_tid = g["home_team_id"]
        away_tid = g["away_team_id"]
        home_pid = g["home_pitcher_id"]
        away_pid = g["away_pitcher_id"]

        home_pnerd = pnerds.get(home_pid, 5.0) if home_pid else 5.0
        away_pnerd = pnerds.get(away_pid, 5.0) if away_pid else 5.0
        home_tnerd = tnerds.get(home_tid, 5.0)
        away_tnerd = tnerds.get(away_tid, 5.0)

        game_nerd, pitcher_comp, team_comp = nerd_calc.compute_game_nerd(
            away_pnerd, home_pnerd, away_tnerd, home_tnerd
        )

        # Collect flags
        game_flags: list[str] = []
        if home_pid is None:
            game_flags.append("TBD_starter")
        if away_pid is None and "TBD_starter" not in game_flags:
            game_flags.append("TBD_starter")
        if home_pid and "low_sample" in p_flags.get(home_pid, []):
            if "low_sample" not in game_flags:
                game_flags.append("low_sample")
        if away_pid and "low_sample" in p_flags.get(away_pid, []):
            if "low_sample" not in game_flags:
                game_flags.append("low_sample")
        if home_pid and "no_velocity_data" in p_flags.get(home_pid, []):
            game_flags.append("no_velocity_data")
        if away_pid and "no_velocity_data" in p_flags.get(away_pid, []):
            if "no_velocity_data" not in game_flags:
                game_flags.append("no_velocity_data")
        if home_pid and "used_fip_fallback" in p_flags.get(home_pid, []):
            game_flags.append("used_fip_fallback")
        if away_pid and "used_fip_fallback" in p_flags.get(away_pid, []):
            if "used_fip_fallback" not in game_flags:
                game_flags.append("used_fip_fallback")

        results.append(GameNERDResult(
            game_pk=g["game_pk"],
            game_date=g["game_date"],
            game_time_et=g["game_time_et"],
            game_number=g.get("game_number", 1),
            status=g["status"],
            away=TeamSummary(
                team_id=away_tid,
                name=g["away_team_name"],
                abbreviation=g["away_team_abbr"],
                tnerd=round(away_tnerd, 2),
            ),
            home=TeamSummary(
                team_id=home_tid,
                name=g["home_team_name"],
                abbreviation=g["home_team_abbr"],
                tnerd=round(home_tnerd, 2),
            ),
            away_pitcher=ProbablePitcher(
                player_id=away_pid,
                name=g["away_pitcher_name"],
            ),
            home_pitcher=ProbablePitcher(
                player_id=home_pid,
                name=g["home_pitcher_name"],
            ),
            away_pnerd=round(away_pnerd, 2),
            home_pnerd=round(home_pnerd, 2),
            pitcher_component=pitcher_comp,
            team_component=team_comp,
            game_nerd=game_nerd,
            flags=game_flags,
        ))

    # Sort by game_nerd descending
    results.sort(key=lambda r: r.game_nerd, reverse=True)

    response = DayScheduleResponse(
        date=date_str,
        games=results,
        generated_at=datetime.utcnow().isoformat() + "Z",
        season=season,
        game_count=len(results),
    )
    _response_cache[date_str] = (time.time(), response)
    return response


@app.get("/api/game/{game_pk}", response_model=GameNERDResult)
async def get_game(game_pk: int):
    """Return NERD score for a specific game using today's date."""
    today = date.today().isoformat()
    day_response = await get_games(today)
    for g in day_response.games:
        if g.game_pk == game_pk:
            return g
    raise HTTPException(status_code=404, detail=f"Game {game_pk} not found in today's schedule")


@app.get("/api/health", response_model=HealthResponse)
async def health():
    cache_entries = len(list(Path(".cache").glob("*.json"))) if Path(".cache").exists() else 0
    loop = asyncio.get_event_loop()
    reachable = await loop.run_in_executor(None, mlb_client.check_api_reachable)
    return HealthResponse(
        status="ok",
        cache_entries=cache_entries,
        api_reachable=reachable,
    )


# ---------------------------------------------------------------------------
# Static files (frontend) — mount last so API routes take precedence
# ---------------------------------------------------------------------------

frontend_path = Path(__file__).parent.parent / "frontend"
if frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(frontend_path), html=True), name="frontend")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _estimate_games_into_season(standings: dict[int, dict]) -> int:
    """Estimate average games played per team from standings data."""
    if not standings:
        return 1
    gp_vals = [s.get("games_played", 0) for s in standings.values()]
    valid = [g for g in gp_vals if g > 0]
    return int(sum(valid) / len(valid)) if valid else 1
