#!/usr/bin/env python3
"""
Fetches and pre-bakes prior-year MLB stats as static JSON files in docs/data/.
Eliminates live API calls for completed seasons, making the site load instantly.

Usage:
    python3 scripts/prebake-prior-year.py          # defaults to last year
    python3 scripts/prebake-prior-year.py 2025

Output files (in docs/data/):
    pitcher_season_{year}.json       — getPitcherSeasonStats output
    pitcher_saber_{year}.json        — getPitcherSabermetrics output
    hitting_saber_{year}.json        — getHittingSabermetrics output
    hitting_season_pa_{year}.json    — getHittingSeasonStats output
    standings_{year}.json            — getStandings output
    pitchdata_{year}.json            — pitch quality per qualifying starter
"""

import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

YEAR = int(sys.argv[1]) if len(sys.argv) > 1 else __import__('datetime').date.today().year - 1
OUT_DIR = Path(__file__).parent.parent / 'docs' / 'data'
MLB_BASE = 'https://statsapi.mlb.com/api/v1'

FASTBALL_CODES = {'FF', 'FT', 'SI', 'FC'}
SWING_CODES    = {'S', 'W', 'F', 'T', 'L', 'O', 'M', 'X', 'D', 'E'}
WHIFF_CODES    = {'S', 'W'}

MIN_GS = 10          # qualifying threshold for pitch data pre-bake
N_GAMES = 5          # last N starts to use for pitch data
MAX_WORKERS = 8      # concurrent API connections


# ---------------------------------------------------------------------------
# Fetch helpers
# ---------------------------------------------------------------------------

def mlb_fetch(path, params=None):
    url = f'{MLB_BASE}{path}'
    if params:
        qs = '&'.join(f'{k}={v}' for k, v in params.items())
        url = f'{url}?{qs}'
    req = urllib.request.Request(url, headers={'User-Agent': 'nerd-prebake/1.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def mlb_fetch_retry(path, params=None, retries=3, delay=2):
    for attempt in range(retries):
        try:
            return mlb_fetch(path, params)
        except Exception as e:
            if attempt == retries - 1:
                raise
            print(f'  Retry {attempt+1}/{retries} for {path}: {e}')
            time.sleep(delay)


# ---------------------------------------------------------------------------
# Data processors (mirror docs/mlb.js logic exactly)
# ---------------------------------------------------------------------------

def process_pitcher_season(raw):
    result = {}
    for split in (raw.get('stats') or [{}])[0].get('splits', []):
        pid = (split.get('player') or {}).get('id')
        if not pid:
            continue
        s = split.get('stat') or {}
        bf = int(s.get('battersFaced') or 0)
        so = int(s.get('strikeOuts') or 0)
        bb = int(s.get('baseOnBalls') or 0)
        try:   era = float(s['era'])
        except: era = None
        result[pid] = {
            'era':          era,
            'wins':         int(s['wins'])   if s.get('wins')   is not None else None,
            'losses':       int(s['losses']) if s.get('losses') is not None else None,
            'whip':         float(s['whip']) if s.get('whip') else None,
            'kPct':         so / bf if bf > 0 else None,
            'bbPct':        bb / bf if bf > 0 else None,
            'hr9':          float(s['homeRunsPer9']) if s.get('homeRunsPer9') else None,
            'ip':           float(s.get('inningsPitched') or 0),
            'gamesStarted': int(s.get('gamesStarted') or 0),
            'gamesPlayed':  int(s.get('gamesPlayed')  or 0),
            'teamId':       (split.get('team') or {}).get('id'),
            'name':         (split.get('player') or {}).get('fullName'),
            'teamAbbr':     (split.get('team') or {}).get('abbreviation'),
            'teamName':     (split.get('team') or {}).get('name'),
        }
    return result


def process_pitcher_saber(raw):
    result = {}
    for split in (raw.get('stats') or [{}])[0].get('splits', []):
        pid = (split.get('player') or {}).get('id')
        if not pid:
            continue
        s = split.get('stat') or {}
        result[pid] = {
            'fip':      float(s['fip'])      if s.get('fip')      else None,
            'xfip':     float(s['xfip'])     if s.get('xfip')     else None,
            'fipMinus': float(s['fipMinus']) if s.get('fipMinus') else None,
            'war':      float(s['war'])      if s.get('war')      else None,
        }
    return result


def process_hitting_saber(raw):
    result = {}
    for split in (raw.get('stats') or [{}])[0].get('splits', []):
        pid = (split.get('player') or {}).get('id')
        if not pid:
            continue
        s = split.get('stat') or {}
        result[pid] = {
            'wrcPlus': float(s['wRcPlus']) if s.get('wRcPlus') else None,
            'woba':    float(s['woba'])    if s.get('woba')    else None,
            'war':     float(s['war'])     if s.get('war')     else None,
            'teamId':  (split.get('team') or {}).get('id'),
            'pa':      0,  # filled in from season stats
        }
    return result


def process_hitting_season_pa(raw):
    result = {}
    for split in (raw.get('stats') or [{}])[0].get('splits', []):
        pid = (split.get('player') or {}).get('id')
        if not pid:
            continue
        s = split.get('stat') or {}
        result[pid] = {
            'pa': int(s.get('plateAppearances') or 0),
            'so': int(s.get('strikeOuts') or 0),
        }
    return result


def process_standings(raw):
    result = {}
    for division in raw.get('records', []):
        for tr in division.get('teamRecords', []):
            tid = (tr.get('team') or {}).get('id')
            if not tid:
                continue
            result[tid] = {
                'wins':            int(tr.get('wins') or 0),
                'losses':          int(tr.get('losses') or 0),
                'gamesPlayed':     int(tr.get('gamesPlayed') or 0),
                'winPct':          float(tr.get('winningPercentage') or 0),
                'runsScored':      int(tr.get('runsScored') or 0),
                'runsAllowed':     int(tr.get('runsAllowed') or 0),
                'runDifferential': int(tr.get('runDifferential') or 0),
                'name':            (tr.get('team') or {}).get('name'),
                'abbr':            (tr.get('team') or {}).get('abbreviation'),
            }
    return result


# ---------------------------------------------------------------------------
# Pitch data (mirrors getPitcherPitchData in mlb.js)
# ---------------------------------------------------------------------------

def get_game_pks(player_id, season):
    """Return gamePks for all starts in the season, most-recent first."""
    raw = mlb_fetch_retry(f'/people/{player_id}/stats',
                          {'stats': 'gameLog', 'group': 'pitching', 'season': season})
    pks = []
    for group in raw.get('stats', []):
        for split in group.get('splits', []):
            if int((split.get('stat') or {}).get('gamesStarted') or 0) >= 1:
                gp = (split.get('game') or {}).get('gamePk')
                if gp:
                    pks.append(int(gp))
    return list(reversed(pks))  # most-recent first


def compute_pitch_data_from_pbp(pbp, player_id):
    speeds, ivbs, hbs, spin_rates = [], [], [], []
    swings = whiffs = 0
    for play in pbp.get('allPlays', []):
        if (play.get('matchup') or {}).get('pitcher', {}).get('id') != player_id:
            continue
        for event in play.get('playEvents', []):
            if not event.get('isPitch'):
                continue
            code = (event.get('details') or {}).get('code', '')
            if code in SWING_CODES:
                swings += 1
                if code in WHIFF_CODES:
                    whiffs += 1
            type_code = ((event.get('details') or {}).get('type') or {}).get('code', '')
            if type_code not in FASTBALL_CODES:
                continue
            pd = event.get('pitchData') or {}
            breaks = pd.get('breaks') or {}
            if pd.get('startSpeed'):
                speeds.append(float(pd['startSpeed']))
            if breaks.get('breakVerticalInduced') is not None:
                ivbs.append(float(breaks['breakVerticalInduced']))
            if breaks.get('breakHorizontal') is not None:
                hbs.append(abs(float(breaks['breakHorizontal'])))
            if breaks.get('spinRate') is not None:
                spin_rates.append(float(breaks['spinRate']))

    def avg(arr):
        return sum(arr) / len(arr) if arr else None

    return {
        'velocity':  avg(speeds),
        'ivb':       avg(ivbs),
        'absHb':     avg(hbs),
        'spinRate':  avg(spin_rates),
        'whiffRate': whiffs / swings if swings > 0 else None,
    }


def fetch_pitch_data_for_pitcher(player_id, season):
    try:
        pks = get_game_pks(player_id, season)
        if not pks:
            return player_id, {'velocity': None, 'ivb': None, 'absHb': None, 'spinRate': None, 'whiffRate': None}

        recent_pks = pks[:N_GAMES]
        speeds, ivbs, hbs, spin_rates = [], [], [], []
        swings = whiffs = 0

        for gp in recent_pks:
            try:
                pbp = mlb_fetch_retry(f'/game/{gp}/playByPlay')
                result = compute_pitch_data_from_pbp(pbp, player_id)
                # Accumulate raw values (re-average at end for correct weighting)
                # Actually just re-call per game would require storing per-pitch arrays.
                # Simpler: re-process each game and accumulate pitch arrays.
                for play in pbp.get('allPlays', []):
                    if (play.get('matchup') or {}).get('pitcher', {}).get('id') != player_id:
                        continue
                    for event in play.get('playEvents', []):
                        if not event.get('isPitch'):
                            continue
                        code = (event.get('details') or {}).get('code', '')
                        if code in SWING_CODES:
                            swings += 1
                            if code in WHIFF_CODES:
                                whiffs += 1
                        type_code = ((event.get('details') or {}).get('type') or {}).get('code', '')
                        if type_code not in FASTBALL_CODES:
                            continue
                        pd = event.get('pitchData') or {}
                        breaks = pd.get('breaks') or {}
                        if pd.get('startSpeed'):
                            speeds.append(float(pd['startSpeed']))
                        if breaks.get('breakVerticalInduced') is not None:
                            ivbs.append(float(breaks['breakVerticalInduced']))
                        if breaks.get('breakHorizontal') is not None:
                            hbs.append(abs(float(breaks['breakHorizontal'])))
                        if breaks.get('spinRate') is not None:
                            spin_rates.append(float(breaks['spinRate']))
            except Exception as e:
                print(f'  Warning: could not fetch pbp {gp} for pitcher {player_id}: {e}')

        def avg(arr):
            return sum(arr) / len(arr) if arr else None

        data = {
            'velocity':  avg(speeds),
            'ivb':       avg(ivbs),
            'absHb':     avg(hbs),
            'spinRate':  avg(spin_rates),
            'whiffRate': whiffs / swings if swings > 0 else None,
        }
        return player_id, data

    except Exception as e:
        print(f'  Error fetching pitch data for pitcher {player_id}: {e}')
        return player_id, {'velocity': None, 'ivb': None, 'absHb': None, 'spinRate': None, 'whiffRate': None}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def save(filename, data):
    path = OUT_DIR / filename
    path.write_text(json.dumps(data, separators=(',', ':')))
    size_kb = path.stat().st_size / 1024
    print(f'  Saved {filename} ({size_kb:.1f} KB, {len(data)} entries)')


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f'Pre-baking {YEAR} stats → {OUT_DIR}\n')

    # -----------------------------------------------------------------------
    # Season-level data (5 fast API calls)
    # -----------------------------------------------------------------------

    print('Fetching pitcher season stats...')
    raw = mlb_fetch('/stats', {'stats': 'season', 'group': 'pitching', 'season': YEAR,
                                'sportId': 1, 'gameType': 'R', 'limit': 2000, 'playerPool': 'All'})
    pitcher_season = process_pitcher_season(raw)
    save(f'pitcher_season_{YEAR}.json', pitcher_season)

    print('Fetching pitcher sabermetrics...')
    raw = mlb_fetch('/stats', {'stats': 'sabermetrics', 'group': 'pitching', 'season': YEAR,
                                'sportId': 1, 'limit': 2000, 'playerPool': 'All'})
    save(f'pitcher_saber_{YEAR}.json', process_pitcher_saber(raw))

    print('Fetching hitting sabermetrics...')
    raw = mlb_fetch('/stats', {'stats': 'sabermetrics', 'group': 'hitting', 'season': YEAR,
                                'sportId': 1, 'limit': 2000, 'playerPool': 'All'})
    save(f'hitting_saber_{YEAR}.json', process_hitting_saber(raw))

    print('Fetching hitting season stats (plate appearances)...')
    raw = mlb_fetch('/stats', {'stats': 'season', 'group': 'hitting', 'season': YEAR,
                                'sportId': 1, 'limit': 2000, 'playerPool': 'All', 'gameType': 'R'})
    save(f'hitting_season_pa_{YEAR}.json', process_hitting_season_pa(raw))

    print('Fetching standings...')
    raw = mlb_fetch('/standings', {'leagueId': '103,104', 'season': YEAR})
    save(f'standings_{YEAR}.json', process_standings(raw))

    # -----------------------------------------------------------------------
    # Pitch data (many concurrent API calls)
    # -----------------------------------------------------------------------

    qualifying = [pid for pid, s in pitcher_season.items() if s['gamesStarted'] >= MIN_GS]
    print(f'\nFetching pitch data for {len(qualifying)} qualifying starters '
          f'(≥{MIN_GS} GS) using {MAX_WORKERS} workers...')
    print('This may take a few minutes.\n')

    pitch_data = {}
    completed = 0

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(fetch_pitch_data_for_pitcher, pid, YEAR): pid
                   for pid in qualifying}
        for future in as_completed(futures):
            pid, data = future.result()
            pitch_data[pid] = data
            completed += 1
            if completed % 10 == 0 or completed == len(qualifying):
                print(f'  {completed}/{len(qualifying)} pitchers done')

    save(f'pitchdata_{YEAR}.json', pitch_data)

    print(f'\nDone. All {YEAR} data files written to {OUT_DIR}')
    print('Next step: update mlb.js to load from these files for prior seasons.')


if __name__ == '__main__':
    main()
