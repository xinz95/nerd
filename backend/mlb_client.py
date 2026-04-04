"""
MLB Stats API client with file-based caching.

All public functions return plain dicts/lists. Caching is transparent —
callers never need to know whether data came from the network or disk.
"""

from __future__ import annotations

import json
import os
import time
from datetime import date
from pathlib import Path
from statistics import mean, median
from concurrent.futures import ThreadPoolExecutor, as_completed

import httpx

BASE_URL = "https://statsapi.mlb.com/api/v1"
CACHE_DIR = Path(".cache")
FASTBALL_CODES = {"FF", "FT", "SI", "FC"}


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

def _cache_path(key: str) -> Path:
    safe = key.replace("/", "_").replace("?", "_").replace("&", "_").replace("=", "_")
    return CACHE_DIR / f"{safe}.json"


def _read_cache(key: str, ttl: int) -> dict | list | None:
    path = _cache_path(key)
    if not path.exists():
        return None
    if time.time() - path.stat().st_mtime > ttl:
        return None
    with open(path) as f:
        return json.load(f)


def _write_cache(key: str, data: dict | list) -> None:
    CACHE_DIR.mkdir(exist_ok=True)
    path = _cache_path(key)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _read_cache_stale(key: str) -> dict | list | None:
    """Return cached data regardless of TTL (used as fallback on API failure)."""
    path = _cache_path(key)
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def _get(url: str, params: dict | None, cache_key: str, ttl: int) -> dict:
    cached = _read_cache(cache_key, ttl)
    if cached is not None:
        return cached

    try:
        resp = httpx.get(url, params=params, timeout=15.0)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        stale = _read_cache_stale(cache_key)
        if stale is not None:
            return stale
        raise

    _write_cache(cache_key, data)
    return data


# ---------------------------------------------------------------------------
# Public API functions
# ---------------------------------------------------------------------------

def get_schedule(game_date: str) -> list[dict]:
    """
    Returns a list of game dicts for the given date (YYYY-MM-DD).
    Each dict has: game_pk, game_date, game_time_et, game_number, status,
    home_team_id, home_team_name, home_team_abbr,
    away_team_id, away_team_name, away_team_abbr,
    home_pitcher_id, home_pitcher_name,
    away_pitcher_id, away_pitcher_name.
    """
    today = date.today().isoformat()
    ttl = 300 if game_date >= today else 86400

    raw = _get(
        f"{BASE_URL}/schedule",
        {"sportId": 1, "date": game_date, "hydrate": "probablePitcher,team,linescore"},
        f"schedule_{game_date}",
        ttl,
    )

    games = []
    for date_entry in raw.get("dates", []):
        for g in date_entry.get("games", []):
            status = g.get("status", {})
            abstract_state = status.get("abstractGameState", "")
            detailed_state = status.get("detailedState", "")

            # Skip postponed / cancelled
            if "Postponed" in detailed_state or "Cancelled" in detailed_state:
                continue

            home = g.get("teams", {}).get("home", {}).get("team", {})
            away = g.get("teams", {}).get("away", {}).get("team", {})

            home_pitcher = g.get("teams", {}).get("home", {}).get("probablePitcher")
            away_pitcher = g.get("teams", {}).get("away", {}).get("probablePitcher")

            # Parse game time (API gives UTC ISO string)
            game_date_str = g.get("gameDate", "")
            game_time_et = _parse_game_time_et(game_date_str)

            games.append({
                "game_pk": g["gamePk"],
                "game_date": g.get("officialDate", game_date),
                "game_time_et": game_time_et,
                "game_number": g.get("gameNumber", 1),
                "status": abstract_state or detailed_state,
                "home_team_id": home.get("id"),
                "home_team_name": home.get("name", ""),
                "home_team_abbr": home.get("abbreviation", ""),
                "away_team_id": away.get("id"),
                "away_team_name": away.get("name", ""),
                "away_team_abbr": away.get("abbreviation", ""),
                "home_pitcher_id": home_pitcher.get("id") if home_pitcher else None,
                "home_pitcher_name": home_pitcher.get("fullName", "TBD") if home_pitcher else "TBD",
                "away_pitcher_id": away_pitcher.get("id") if away_pitcher else None,
                "away_pitcher_name": away_pitcher.get("fullName", "TBD") if away_pitcher else "TBD",
            })

    return games


def _parse_game_time_et(iso_str: str) -> str:
    """Convert UTC ISO string to ET display string (approximate, -4 or -5 hrs)."""
    if not iso_str:
        return "TBD"
    try:
        # e.g. "2026-04-04T17:10:00Z" → 17 - 4 = 13 → 1:10 PM
        time_part = iso_str.split("T")[1].replace("Z", "")
        h, m, _ = time_part.split(":")
        h = int(h)
        # Use EDT (-4) from March-November, EST (-5) otherwise
        offset = 4  # EDT for April
        h_et = h - offset
        if h_et < 0:
            h_et += 24
        ampm = "AM" if h_et < 12 else "PM"
        h_12 = h_et % 12 or 12
        return f"{h_12}:{m} {ampm}"
    except Exception:
        return "TBD"


def get_pitcher_season_stats(season: int) -> dict[int, dict]:
    """Returns dict keyed by player_id with season pitching stats."""
    raw = _get(
        f"{BASE_URL}/stats",
        {"stats": "season", "group": "pitching", "season": season,
         "sportId": 1, "gameType": "R", "limit": 2000},
        f"pitcher_season_{season}",
        3600,
    )

    result: dict[int, dict] = {}
    for split in raw.get("stats", [{}])[0].get("splits", []):
        pid = split.get("player", {}).get("id")
        if not pid:
            continue
        s = split.get("stat", {})
        result[pid] = {
            "era": _float(s.get("era")),
            "whip": _float(s.get("whip")),
            "k9": _float(s.get("strikeoutsPer9Inn")),
            "bb9": _float(s.get("walksPer9Inn")),
            "hr9": _float(s.get("homeRunsPer9")),
            "ip": _float(s.get("inningsPitched")),
            "games_started": _int(s.get("gamesStarted")),
            "strikeouts": _int(s.get("strikeOuts")),
            "walks": _int(s.get("baseOnBalls")),
            "team_id": split.get("team", {}).get("id"),
        }
    return result


def get_pitcher_sabermetrics(season: int) -> dict[int, dict]:
    """Returns dict keyed by player_id with sabermetric pitching stats."""
    raw = _get(
        f"{BASE_URL}/stats",
        {"stats": "sabermetrics", "group": "pitching", "season": season,
         "sportId": 1, "limit": 2000},
        f"pitcher_saber_{season}",
        3600,
    )

    result: dict[int, dict] = {}
    for split in raw.get("stats", [{}])[0].get("splits", []):
        pid = split.get("player", {}).get("id")
        if not pid:
            continue
        s = split.get("stat", {})
        result[pid] = {
            "fip": _float(s.get("fip")),
            "xfip": _float(s.get("xfip")),
            "fip_minus": _float(s.get("fipMinus")),
            "era_minus": _float(s.get("eraMinus")),
            "war": _float(s.get("war")),
            "ra9_war": _float(s.get("ra9War")),
        }
    return result


def get_hitting_sabermetrics(season: int) -> dict[int, dict]:
    """Returns dict keyed by player_id with sabermetric hitting stats, including team_id."""
    raw = _get(
        f"{BASE_URL}/stats",
        {"stats": "sabermetrics", "group": "hitting", "season": season,
         "sportId": 1, "limit": 2000},
        f"hitting_saber_{season}",
        3600,
    )

    result: dict[int, dict] = {}
    for split in raw.get("stats", [{}])[0].get("splits", []):
        pid = split.get("player", {}).get("id")
        if not pid:
            continue
        s = split.get("stat", {})
        result[pid] = {
            "wrc_plus": _float(s.get("wRcPlus")),
            "woba": _float(s.get("woba")),
            "war": _float(s.get("war")),
            "team_id": split.get("team", {}).get("id"),
        }
    return result


def get_standings(season: int) -> dict[int, dict]:
    """Returns dict keyed by team_id with standings data."""
    raw = _get(
        f"{BASE_URL}/standings",
        {"leagueId": "103,104", "season": season},
        f"standings_{season}",
        1800,
    )

    result: dict[int, dict] = {}
    for division in raw.get("records", []):
        for tr in division.get("teamRecords", []):
            team_id = tr.get("team", {}).get("id")
            if not team_id:
                continue
            result[team_id] = {
                "wins": _int(tr.get("wins")),
                "losses": _int(tr.get("losses")),
                "games_played": _int(tr.get("gamesPlayed")),
                "win_pct": _float(tr.get("winningPercentage")),
                "runs_scored": _int(tr.get("runsScored")),
                "runs_allowed": _int(tr.get("runsAllowed")),
                "run_differential": _int(tr.get("runDifferential")),
            }
    return result


def get_player_game_log(player_id: int, season: int) -> list[int]:
    """Returns list of gamePk values for recent starts, most recent first."""
    raw = _get(
        f"{BASE_URL}/people/{player_id}/stats",
        {"stats": "gameLog", "group": "pitching", "season": season},
        f"gamelog_{player_id}_{season}",
        3600,
    )

    game_pks = []
    for stat_group in raw.get("stats", []):
        for split in stat_group.get("splits", []):
            s = split.get("stat", {})
            if _int(s.get("gamesStarted")) >= 1:
                gp = split.get("game", {}).get("gamePk")
                if gp:
                    game_pks.append(int(gp))

    # Most recent first (splits come in chronological order, so reverse)
    return list(reversed(game_pks))


def get_play_by_play(game_pk: int) -> dict:
    """Returns raw play-by-play response for a game."""
    return _get(
        f"{BASE_URL}/game/{game_pk}/playByPlay",
        None,
        f"pbp_{game_pk}",
        86400,
    )


def get_pitcher_velocity(player_id: int, season: int, n_games: int = 5) -> float | None:
    """
    Returns average fastball velocity for a pitcher from their last n_games starts.
    Returns None if no pitch data is available.
    """
    cache_key = f"velocity_{player_id}_{season}_{n_games}"
    cached = _read_cache(cache_key, 3600)
    if cached is not None:
        return cached.get("velocity")

    game_pks = get_player_game_log(player_id, season)
    if not game_pks:
        _write_cache(cache_key, {"velocity": None})
        return None

    speeds: list[float] = []
    for gp in game_pks[:n_games]:
        try:
            pbp = get_play_by_play(gp)
        except Exception:
            continue
        for play in pbp.get("allPlays", []):
            # Matchup (pitcher ID) is at the play level, not the event level
            pitcher_id = play.get("matchup", {}).get("pitcher", {}).get("id")
            if pitcher_id != player_id:
                continue
            for event in play.get("playEvents", []):
                if not event.get("isPitch", False):
                    continue
                pitch_type = event.get("details", {}).get("type", {}).get("code", "")
                if pitch_type not in FASTBALL_CODES:
                    continue
                speed = event.get("pitchData", {}).get("startSpeed")
                if speed:
                    speeds.append(float(speed))

    velocity = mean(speeds) if speeds else None
    _write_cache(cache_key, {"velocity": velocity})
    return velocity


def get_pitcher_velocities_parallel(pitcher_ids: list[int], season: int) -> dict[int, float | None]:
    """Fetch velocities for multiple pitchers concurrently."""
    results: dict[int, float | None] = {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(get_pitcher_velocity, pid, season): pid for pid in pitcher_ids}
        for future in as_completed(futures):
            pid = futures[future]
            try:
                results[pid] = future.result()
            except Exception:
                results[pid] = None
    return results


def check_api_reachable() -> bool:
    """Lightweight check that MLB Stats API is up."""
    try:
        resp = httpx.get(f"{BASE_URL}/sports", timeout=5.0)
        return resp.status_code == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _float(val) -> float | None:
    if val is None:
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _int(val) -> int:
    if val is None:
        return 0
    try:
        return int(val)
    except (TypeError, ValueError):
        return 0
