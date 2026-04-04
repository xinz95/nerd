"""
NERD score computation — pure Python, no I/O.

Pitcher NERD (pNERD, 0-10):
  Components z-scored across all qualifying SP league-wide, weighted sum
  mapped to 0-10 scale (league avg = 5).

  weights: xFIP (inverted) 30%, K/9 25%, BB/9 (inverted) 20%, velocity 25%

Team NERD (tNERD, 0-10):
  Z-scored across all 30 teams.

  weights: wRC+ 35%, proxy ERA (inverted) 30%, Pythagorean luck (inverted) 20%,
           abs run diff per game (inverted) 15%

Game NERD:
  = avg(pNERDs) * 0.6 + avg(tNERDs) * 0.4
"""

from __future__ import annotations

import math
from statistics import mean, median, stdev


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_stdev(values: list[float]) -> float:
    if len(values) < 2:
        return 1.0  # avoid divide-by-zero; z-score will be 0
    s = stdev(values)
    return s if s > 0 else 1.0


def _zscore(value: float, mu: float, sigma: float) -> float:
    return (value - mu) / sigma


def _z_to_10(z: float) -> float:
    """Map z-score to 0-10 scale. Clips at ±3 std devs."""
    z_clipped = max(-3.0, min(3.0, z))
    return 5.0 + (z_clipped / 3.0) * 5.0


def pythagorean_winpct(runs_scored: int, runs_allowed: int, exp: float = 1.83) -> float:
    if runs_scored + runs_allowed == 0:
        return 0.500
    rs = runs_scored ** exp
    ra = runs_allowed ** exp
    return rs / (rs + ra)


# ---------------------------------------------------------------------------
# Pitcher NERD
# ---------------------------------------------------------------------------

PNERD_WEIGHTS = {
    "xfip_inv": 0.30,
    "k9": 0.25,
    "bb9_inv": 0.20,
    "velocity": 0.25,
}


def compute_all_pnerds(
    season_stats: dict[int, dict],
    saber_stats: dict[int, dict],
    velocities: dict[int, float | None],
    min_ip: float = 5.0,
) -> tuple[dict[int, float], dict[int, list[str]]]:
    """
    Returns (pnerd_scores, flags) for all pitcher IDs present in saber_stats.
    pnerd_scores: {player_id: score}
    flags: {player_id: [flag_strings]}
    """
    # Determine league median velocity for fallback
    valid_vels = [v for v in velocities.values() if v is not None]
    league_median_velocity = median(valid_vels) if valid_vels else 93.0

    # Build per-pitcher rows with all components
    rows: dict[int, dict] = {}
    for pid, saber in saber_stats.items():
        season = season_stats.get(pid, {})
        ip = season.get("ip") or 0.0

        # Need at least some IP to qualify for z-score population
        if ip < min_ip:
            continue

        xfip = saber.get("xfip")
        fip = saber.get("fip")
        k9 = season.get("k9")
        bb9 = season.get("bb9")

        # Need at least xFIP or FIP and K/9
        if (xfip is None and fip is None) or k9 is None:
            continue

        rows[pid] = {
            "xfip": xfip if xfip is not None else fip,
            "used_fip": xfip is None,
            "k9": k9,
            "bb9": bb9 if bb9 is not None else 3.5,  # league-avg fallback
            "velocity": velocities.get(pid) or league_median_velocity,
            "no_velocity": velocities.get(pid) is None,
            "ip": ip,
            "starts": season.get("games_started", 0),
        }

    if not rows:
        # No data at all — return league average for everyone
        all_ids = set(saber_stats) | set(season_stats)
        return {pid: 5.0 for pid in all_ids}, {pid: ["insufficient_data"] for pid in all_ids}

    # Compute population stats for each component
    xfip_vals = [r["xfip"] for r in rows.values()]
    k9_vals = [r["k9"] for r in rows.values()]
    bb9_vals = [r["bb9"] for r in rows.values()]
    vel_vals = [r["velocity"] for r in rows.values()]

    xfip_mu, xfip_sig = mean(xfip_vals), _safe_stdev(xfip_vals)
    k9_mu, k9_sig = mean(k9_vals), _safe_stdev(k9_vals)
    bb9_mu, bb9_sig = mean(bb9_vals), _safe_stdev(bb9_vals)
    vel_mu, vel_sig = mean(vel_vals), _safe_stdev(vel_vals)

    low_sample_pop = len(rows) < 15

    pnerds: dict[int, float] = {}
    flags: dict[int, list[str]] = {}

    for pid, r in rows.items():
        pid_flags: list[str] = []

        if r["used_fip"]:
            pid_flags.append("used_fip_fallback")
        if r["no_velocity"]:
            pid_flags.append("no_velocity_data")
        if r["starts"] < 3:
            pid_flags.append("low_sample")
        if low_sample_pop:
            pid_flags.append("low_sample")

        # Z-scores; xFIP and BB/9 are inverted (lower is better)
        z_xfip = -_zscore(r["xfip"], xfip_mu, xfip_sig)
        z_k9 = _zscore(r["k9"], k9_mu, k9_sig)
        z_bb9 = -_zscore(r["bb9"], bb9_mu, bb9_sig)
        z_vel = _zscore(r["velocity"], vel_mu, vel_sig)

        composite_z = (
            z_xfip * PNERD_WEIGHTS["xfip_inv"]
            + z_k9 * PNERD_WEIGHTS["k9"]
            + z_bb9 * PNERD_WEIGHTS["bb9_inv"]
            + z_vel * PNERD_WEIGHTS["velocity"]
        )

        pnerds[pid] = _z_to_10(composite_z)
        flags[pid] = pid_flags

    # For pitchers with data but below min_ip (e.g. first start of season),
    # assign league average
    for pid in set(saber_stats) | set(season_stats):
        if pid not in pnerds:
            pnerds[pid] = 5.0
            flags[pid] = ["insufficient_data"]

    return pnerds, flags


# ---------------------------------------------------------------------------
# Team NERD
# ---------------------------------------------------------------------------

TNERD_WEIGHTS = {
    "wrc_plus": 0.35,
    "proxy_era_inv": 0.30,
    "luck_inv": 0.20,
    "run_diff_inv": 0.15,
}


def compute_all_tnerds(
    standings: dict[int, dict],
    hitting_saber: dict[int, dict],
    min_games: int = 3,
) -> dict[int, float]:
    """Returns {team_id: tnerd_score} for all teams in standings."""
    # Aggregate wRC+ per team: median of qualified batters (≥10 games)
    team_wrc: dict[int, list[float]] = {}
    for pid, h in hitting_saber.items():
        tid = h.get("team_id")
        wrc = h.get("wrc_plus")
        if tid and wrc is not None:
            team_wrc.setdefault(tid, []).append(wrc)

    team_median_wrc: dict[int, float] = {}
    for tid, vals in team_wrc.items():
        team_median_wrc[tid] = median(vals) if vals else 100.0

    # Build per-team rows
    rows: dict[int, dict] = {}
    for team_id, st in standings.items():
        gp = st.get("games_played", 0)
        if gp < min_games:
            continue

        rs = st.get("runs_scored", 0)
        ra = st.get("runs_allowed", 0)
        wins = st.get("wins", 0)
        losses = st.get("losses", 0)
        total_games = wins + losses
        actual_winpct = wins / total_games if total_games > 0 else 0.500

        pyth = pythagorean_winpct(rs, ra)
        luck = actual_winpct - pyth  # positive = overperforming (less watchable)

        proxy_era = ra / (gp * 9) * 9 if gp > 0 else 4.50  # runs allowed per 9
        rd_per_game = st.get("run_differential", 0) / gp if gp > 0 else 0.0

        rows[team_id] = {
            "wrc_plus": team_median_wrc.get(team_id, 100.0),
            "proxy_era": proxy_era,
            "luck": luck,
            "abs_rd_per_game": abs(rd_per_game),
        }

    if not rows:
        return {tid: 5.0 for tid in standings}

    # Population stats
    wrc_vals = [r["wrc_plus"] for r in rows.values()]
    era_vals = [r["proxy_era"] for r in rows.values()]
    luck_vals = [r["luck"] for r in rows.values()]
    rd_vals = [r["abs_rd_per_game"] for r in rows.values()]

    wrc_mu, wrc_sig = mean(wrc_vals), _safe_stdev(wrc_vals)
    era_mu, era_sig = mean(era_vals), _safe_stdev(era_vals)
    luck_mu, luck_sig = mean(luck_vals), _safe_stdev(luck_vals)
    rd_mu, rd_sig = mean(rd_vals), _safe_stdev(rd_vals)

    tnerds: dict[int, float] = {}
    for team_id, r in rows.items():
        z_wrc = _zscore(r["wrc_plus"], wrc_mu, wrc_sig)
        z_era = -_zscore(r["proxy_era"], era_mu, era_sig)    # lower ERA = better
        z_luck = -_zscore(r["luck"], luck_mu, luck_sig)       # overperforming = less interesting
        z_rd = -_zscore(r["abs_rd_per_game"], rd_mu, rd_sig)  # near-0 diff = more competitive

        composite_z = (
            z_wrc * TNERD_WEIGHTS["wrc_plus"]
            + z_era * TNERD_WEIGHTS["proxy_era_inv"]
            + z_luck * TNERD_WEIGHTS["luck_inv"]
            + z_rd * TNERD_WEIGHTS["run_diff_inv"]
        )

        tnerds[team_id] = _z_to_10(composite_z)

    # Teams in standings but without enough games
    for tid in standings:
        if tid not in tnerds:
            tnerds[tid] = 5.0

    return tnerds


# ---------------------------------------------------------------------------
# Game NERD
# ---------------------------------------------------------------------------

def compute_game_nerd(
    away_pnerd: float,
    home_pnerd: float,
    away_tnerd: float,
    home_tnerd: float,
) -> tuple[float, float, float]:
    """Returns (game_nerd, pitcher_component, team_component)."""
    pitcher_component = (away_pnerd + home_pnerd) / 2.0
    team_component = (away_tnerd + home_tnerd) / 2.0
    game_nerd = pitcher_component * 0.6 + team_component * 0.4
    return round(max(0.0, min(10.0, game_nerd)), 2), round(pitcher_component, 2), round(team_component, 2)
