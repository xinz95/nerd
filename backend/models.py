from __future__ import annotations
from typing import List, Optional
from pydantic import BaseModel


class ProbablePitcher(BaseModel):
    player_id: Optional[int]
    name: str  # "TBD" if unknown


class TeamSummary(BaseModel):
    team_id: int
    name: str
    abbreviation: str
    tnerd: float


class GameNERDResult(BaseModel):
    game_pk: int
    game_date: str
    game_time_et: str        # e.g. "7:10 PM"
    game_number: int         # 1 or 2 for doubleheaders
    status: str              # "Preview", "Live", "Final", etc.
    away: TeamSummary
    home: TeamSummary
    away_pitcher: ProbablePitcher
    home_pitcher: ProbablePitcher
    away_pnerd: float
    home_pnerd: float
    pitcher_component: float  # weighted avg of both pNERDs
    team_component: float     # weighted avg of both tNERDs
    game_nerd: float
    flags: List[str]


class DayScheduleResponse(BaseModel):
    date: str
    games: List[GameNERDResult]
    generated_at: str
    season: int
    game_count: int


class HealthResponse(BaseModel):
    status: str
    cache_entries: int
    api_reachable: bool
