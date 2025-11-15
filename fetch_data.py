import os
import datetime as dt
from typing import Any, Dict, List, Optional

import requests

# ------------------------------------------------------------------
# CONSTANTS
# ------------------------------------------------------------------

SLEEPER_LEAGUE_ID = "1202885172400234496"
SLEEPER_BASE = "https://api.sleeper.app/v1"
BALLDONTLIE_BASE = "https://api.balldontlie.io/v1"
ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
NBA_SCHEDULE_URL_TEMPLATE = "https://data.nba.net/prod/v2/{season}/schedule.json"


# ------------------------------------------------------------------
# HELPER: GENERIC GET WRAPPER
# ------------------------------------------------------------------

def _get_json(
    url: str,
    *,
    params: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
) -> Any:
    resp = requests.get(url, params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json()


# ------------------------------------------------------------------
# SLEEPER HELPERS
# ------------------------------------------------------------------

def fetch_sleeper_league_metadata() -> Dict[str, Any]:
    """
    Returns:
      {
        "league": {...},
        "users": [...],
      }
    """
    league = _get_json(f"{SLEEPER_BASE}/league/{SLEEPER_LEAGUE_ID}")
    users = _get_json(f"{SLEEPER_BASE}/league/{SLEEPER_LEAGUE_ID}/users")
    return {"league": league, "users": users}


def fetch_sleeper_rosters() -> List[Dict[str, Any]]:
    """
    List of rosters for your Sleeper league.
    """
    return _get_json(f"{SLEEPER_BASE}/league/{SLEEPER_LEAGUE_ID}/rosters")


def fetch_sleeper_players() -> Dict[str, Any]:
    """
    Huge dict of Sleeper NBA players:
      { player_id: { ...player metadata... }, ... }
    """
    return _get_json(f"{SLEEPER_BASE}/players/nba")


def fetch_sleeper_transactions(max_weeks: int = 30) -> List[Dict[str, Any]]:
    """
    Flattened list of all transactions across league weeks.
    """
    all_txns: List[Dict[str, Any]] = []

    for week in range(1, max_weeks + 1):
        url = f"{SLEEPER_BASE}/league/{SLEEPER_LEAGUE_ID}/transactions/{week}"
        try:
            txns = _get_json(url)
        except requests.HTTPError as e:
            # 404 usually means we’ve gone past the last active week
            if e.response is not None and e.response.status_code == 404:
                break
            raise

        if not txns:
            # Empty list – also a signal we’re past real data
            break

        all_txns.extend(txns)

    print(f"Fetched {len(all_txns)} total transactions.")
    return all_txns


# ------------------------------------------------------------------
# ESPN INJURIES
# ------------------------------------------------------------------

def fetch_espn_injuries() -> List[Dict[str, Any]]:
    """
    Returns a flat list of injury dicts shaped like:

      {
        'player_id': str,
        'player_name': str,
        'team_abbr': str,
        'position': str,
        'status': str,
        'description': str,
      }
    """
    try:
        data = _get_json(ESPN_INJURIES_URL)
    except Exception as e:
        print(f"Failed to fetch ESPN injuries: {e}")
        return []

    injuries: List[Dict[str, Any]] = []

    for sport in data.get("sports", []):
        for league in sport.get("leagues", []):
            for team in league.get("teams", []):
                team_info = team.get("team", {}) or {}
                team_abbr = team_info.get("abbreviation")

                for inj in team.get("injuries", []):
                    athlete = inj.get("athlete", {}) or {}
                    status = inj.get("status", {}) or {}

                    injuries.append(
                        {
                            "player_id": athlete.get("id"),
                            "player_name": athlete.get("displayName"),
                            "team_abbr": team_abbr,
                            "position": (athlete.get("position") or {}).get(
                                "abbreviation"
                            ),
                            "status": (status.get("type") or {}).get("name"),
                            "description": status.get("detail"),
                        }
                    )

    print(f"Parsed {len(injuries)} ESPN injuries.")
    return injuries


# ------------------------------------------------------------------
# NBA SCHEDULE (data.nba.net – flaky but kept for now)
# ------------------------------------------------------------------

def fetch_nba_schedule(season: int) -> Dict[str, Any]:
    """
    Fetch raw NBA schedule JSON from data.nba.net.

    This endpoint has had SSL / hostname issues recently.
    We swallow failures and return {} so the rest of the pipeline still runs.
    """
    url = NBA_SCHEDULE_URL_TEMPLATE.format(season=season)
    try:
        print(f"GET {url}")
        return _get_json(url)
    except Exception as e:
        print(f"Failed to fetch NBA schedule: {e}")
        return {}


# ------------------------------------------------------------------
# BALLDONTLIE – GAME LOGS
# ------------------------------------------------------------------

def _get_balldontlie_headers() -> Optional[Dict[str, str]]:
    api_key = os.environ.get("BALLDONTLIE_API_KEY")
    if not api_key:
        return None

    # Official docs: Authorization: YOUR_API_KEY
    # (no Bearer prefix)
    return {"Authorization": api_key}


def fetch_nba_game_logs_since(start_date: dt.date) -> List[Dict[str, Any]]:
    """
    Fetch player game stats from BALLDONTLIE for dates > start_date up to today (inclusive).

    Returns a list of simplified stat dicts keyed by:
      game_id, game_date, season, home_team_id, visitor_team_id,
      player_id, player_name, team_id, team_abbr,
      min, pts, reb, ast, stl, blk, turnover, fgm, fga, fg3m, fg3a, ftm, fta, pf
    """
    headers = _get_balldontlie_headers()
    if headers is None:
        print("BALLDONTLIE_API_KEY not set; skipping game log fetch.")
        return []

    today = dt.date.today()
    current = start_date + dt.timedelta(days=1)

    all_logs: List[Dict[str, Any]] = []

    while current <= today:
        date_str = current.isoformat()
        print(f"Fetching logs for {date_str}")

        url = f"{BALLDONTLIE_BASE}/stats"
        params: Dict[str, Any] = {
            "dates[]": date_str,
            "per_page": 100,  # max allowed
        }

        try:
            while True:
                resp = requests.get(url, params=params, headers=headers, timeout=30)
                if resp.status_code == 401:
                    raise requests.HTTPError("Unauthorized", response=resp)
                resp.raise_for_status()

                payload = resp.json()
                for stat in payload.get("data", []):
                    game = stat.get("game", {}) or {}
                    player = stat.get("player", {}) or {}
                    team = stat.get("team", {}) or {}

                    all_logs.append(
                        {
                            "game_id": game.get("id"),
                            "game_date": (game.get("date") or "")[:10],
                            "season": game.get("season"),
                            "home_team_id": game.get("home_team_id"),
                            "visitor_team_id": game.get("visitor_team_id"),
                            "player_id": player.get("id"),
                            "player_name": f"{player.get('first_name', '')} {player.get('last_name', '')}".strip(),
                            "team_id": team.get("id"),
                            "team_abbr": team.get("abbreviation"),
                            # Box score stats
                            "min": stat.get("min"),
                            "pts": stat.get("pts"),
                            "reb": stat.get("reb"),
                            "ast": stat.get("ast"),
                            "stl": stat.get("stl"),
                            "blk": stat.get("blk"),
                            "turnover": stat.get("turnover"),
                            "fgm": stat.get("fgm"),
                            "fga": stat.get("fga"),
                            "fg3m": stat.get("fg3m"),
                            "fg3a": stat.get("fg3a"),
                            "ftm": stat.get("ftm"),
                            "fta": stat.get("fta"),
                            "pf": stat.get("pf"),
                        }
                    )

                meta = payload.get("meta") or {}
                next_cursor = meta.get("next_cursor")
                if not next_cursor:
                    break

                # Paginate
                params["cursor"] = next_cursor

        except requests.HTTPError as e:
            if e.response is not None:
                print(
                    f"Failed to fetch logs for {date_str}: "
                    f"{e.response.status_code} {e}"
                )
            else:
                print(f"Failed to fetch logs for {date_str}: {e}")
        except Exception as e:
            print(f"Failed to fetch logs for {date_str}: {e}")

        current += dt.timedelta(days=1)

    print(f"Fetched {len(all_logs)} new game logs.")
    return all_logs


# ------------------------------------------------------------------
# WRAPPER FOR SLEEPER NBA METADATA
# ------------------------------------------------------------------

def fetch_sleeper_nba_metadata() -> Dict[str, Any]:
    """
    Thin wrapper so update_nba_historical.py can call this and
    always get {'players': {...}}.
    """
    players = fetch_sleeper_players()
    return {"players": players}
