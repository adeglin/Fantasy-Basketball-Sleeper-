"""
fetch_data.py

Central place to fetch:
- NBA boxscores (via nba_api)
- Sleeper league data
- ESPN injuries

This version:
- Does NOT use balldontlie at all.
- Requires `nba_api` and `requests` (installed in the workflow).
"""

import time
from datetime import datetime
from typing import List, Dict, Any

import requests
from nba_api.stats.endpoints import leaguegamefinder, boxscoretraditionalv2

# -----------------------------
# Sleeper configuration
# -----------------------------
SLEEPER_BASE_URL = "https://api.sleeper.app/v1"
SLEEPER_LEAGUE_ID = "1202885172400234496"  # your league


# -----------------------------
# NBA via nba_api
# -----------------------------

def fetch_nba_games_for_date(date_str: str) -> List[Dict[str, Any]]:
    """
    Use nba_api's LeagueGameFinder to get all NBA games for a specific date.

    date_str: "YYYY-MM-DD"
    Returns: list of game dicts (one per game)
    """
    # nba_api expects dates like "MM/DD/YYYY" or "YYYY-MM-DD" depending on endpoint,
    # but LeagueGameFinder works fine with ISO format for from/to.
    lgf = leaguegamefinder.LeagueGameFinder(
        league_id_nullable="00",
        date_from_nullable=date_str,
        date_to_nullable=date_str
    )

    games_df = lgf.get_data_frames()[0]
    games = games_df.to_dict("records")
    return games


def fetch_nba_boxscores_for_date(date_str: str) -> List[Dict[str, Any]]:
    """
    For each game on a date, fetch the traditional box score.

    Returns a list of dicts, each entry like:
    {
      "game_id": "...",
      "game_date": "YYYY-MM-DD",
      "home_team_id": ...,
      "away_team_id": ...,
      "players": [ {...}, {...}, ... ]
    }
    """
    games = fetch_nba_games_for_date(date_str)
    if not games:
        return []

    results: List[Dict[str, Any]] = []

    for game in games:
        game_id = game.get("GAME_ID")
        if not game_id:
            continue

        # Sleep a bit to be polite / avoid rate limits
        time.sleep(0.6)

        box = boxscoretraditionalv2.BoxScoreTraditionalV2(game_id=game_id)
        df = box.player_stats.get_data_frame()
        players = df.to_dict("records")

        # Basic home/away info
        home_team_id = game.get("HOME_TEAM_ID")
        away_team_id = game.get("VISITOR_TEAM_ID")

        results.append(
            {
                "game_id": game_id,
                "game_date": date_str,
                "home_team_id": home_team_id,
                "away_team_id": away_team_id,
                "game": game,
                "players": players,
            }
        )

    return results


# -----------------------------
# Sleeper helpers
# -----------------------------

def _get_json(url: str, timeout: int = 30) -> Any:
    resp = requests.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


def fetch_sleeper_league() -> Dict[str, Any]:
    url = f"{SLEEPER_BASE_URL}/league/{SLEEPER_LEAGUE_ID}"
    return _get_json(url)


def fetch_sleeper_users() -> List[Dict[str, Any]]:
    url = f"{SLEEPER_BASE_URL}/league/{SLEEPER_LEAGUE_ID}/users"
    return _get_json(url)


def fetch_sleeper_rosters() -> List[Dict[str, Any]]:
    url = f"{SLEEPER_BASE_URL}/league/{SLEEPER_LEAGUE_ID}/rosters"
    return _get_json(url)


def fetch_sleeper_transactions(max_weeks: int = 30) -> List[Dict[str, Any]]:
    """
    Grab all transactions week by week until we hit a 404 or reach max_weeks.
    """
    all_tx: List[Dict[str, Any]] = []
    for week in range(1, max_weeks + 1):
        url = f"{SLEEPER_BASE_URL}/league/{SLEEPER_LEAGUE_ID}/transactions/{week}"
        resp = requests.get(url, timeout=30)
        if resp.status_code == 404:
            break
        resp.raise_for_status()
        week_tx = resp.json()
        if not week_tx:
            continue
        all_tx.extend(week_tx)
    return all_tx


def fetch_sleeper_players() -> Dict[str, Any]:
    """
    Sleeper players endpoint. This can be large, but it's useful to have.
    """
    url = f"https://api.sleeper.app/v1/players/nba"
    return _get_json(url, timeout=60)

def fetch_sleeper_league_data(league_id: str) -> Dict[str, Any]:
    """
    Convenience wrapper used by update_engine.run_update.

    It fetches all the Sleeper pieces we need and returns them in the
    exact structure the frontend expects under bundle["sleeper"].
    """
    # Raw pieces
    league = fetch_sleeper_league()
    users = fetch_sleeper_users()
    rosters = fetch_sleeper_rosters()
    transactions = fetch_sleeper_transactions()
    players_raw = fetch_sleeper_players()  # dict keyed by player_id

    # Map user_id -> display_name
    user_map = {
        str(u.get("user_id")): (u.get("display_name") or u.get("username") or str(u.get("user_id")))
        for u in users
    }

    # Normalize players into a list
    players_list: List[Dict[str, Any]] = []
    for pid, pdata in players_raw.items():
        full_name = (
            pdata.get("full_name")
            or " ".join(filter(None, [pdata.get("first_name"), pdata.get("last_name")]))
            or pid
        )

        players_list.append(
            {
                "sleeper_player_id": pid,
                "full_name": full_name,
                "team": pdata.get("team"),
                "position": pdata.get("position"),
                "fantasy_positions": pdata.get("fantasy_positions") or [],
                "status": pdata.get("status"),
                "injury_status": pdata.get("injury_status"),
                "injury_notes": pdata.get("injury_notes"),
                "active": pdata.get("active"),
            }
        )

    # Build joined roster-player rows (for the Rosters tab)
    rosters_players: List[Dict[str, Any]] = []
    for r in rosters:
        roster_id = r.get("roster_id")
        owner_id = str(r.get("owner_id"))
        display_name = user_map.get(owner_id, owner_id)
        for pid in r.get("players") or []:
            rosters_players.append(
                {
                    "roster_id": roster_id,
                    "owner_id": owner_id,
                    "display_name": display_name,
                    "sleeper_player_id": pid,
                }
            )

    return {
        "league": league,
        "users": users,
        "rosters": rosters,
        "transactions": transactions,
        "players": players_list,
        "rosters_players": rosters_players,
    }

# -----------------------------
# ESPN injuries
# -----------------------------

def fetch_espn_injuries() -> List[Dict[str, Any]]:
    """
    Return the raw ESPN injuries structure.

    You can normalize this later in the front end if you like.
    """
    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return []

    # Different ESPN versions structure this slightly differently; just return the raw list
    injuries = data.get("injuries") or data.get("league", {}).get("injuries") or []
    return injuries
