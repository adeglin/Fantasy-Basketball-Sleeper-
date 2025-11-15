# fetch_data.py

import os
import datetime as dt
from typing import Any, Dict, List, Optional

import requests

# ---- Configuration ---------------------------------------------------------

SLEEPER_BASE_URL = "https://api.sleeper.app/v1"
BALLDONTLIE_BASE_URL = "https://api.balldontlie.io/v1"
ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"

# Hard-code your Sleeper league id here so the rest of the code can just import and use it.
SLEEPER_LEAGUE_ID = "1202885172400234496"


def _get_ball_dont_lie_headers() -> Dict[str, str]:
    """
    Build headers for BALLDONTLIE requests.

    Reads the API key from the BALLDONTLIE_API_KEY environment variable.
    """
    api_key = os.getenv("BALLDONTLIE_API_KEY")
    if not api_key:
        # Caller will usually just skip if this is missing.
        print("BALLDONTLIE_API_KEY not set; requests to BallDontLie will fail.")
        return {}
    return {"Authorization": api_key}


def _http_get(
    url: str,
    params: Optional[Dict[str, Any]] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 15,
) -> Optional[Dict[str, Any]]:
    """
    Small helper around requests.get with basic error handling.

    Returns parsed JSON dict on success, or None on failure.
    """
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except requests.HTTPError as e:
        try:
            status = e.response.status_code
        except Exception:
            status = "?"
        print(f"HTTP error {status} for GET {url} params={params}: {e}")
    except Exception as e:
        print(f"Error during GET {url} params={params}: {e}")
    return None


# ---------------------------------------------------------------------------
# Sleeper helpers
# ---------------------------------------------------------------------------


def fetch_sleeper_league_metadata(league_id: str = SLEEPER_LEAGUE_ID) -> Dict[str, Any]:
    """
    Fetch base league metadata and users for the Sleeper league.
    """
    league_url = f"{SLEEPER_BASE_URL}/league/{league_id}"
    users_url = f"{SLEEPER_BASE_URL}/league/{league_id}/users"

    league = _http_get(league_url) or {}
    users = _http_get(users_url) or []

    return {
        "league": league,
        "users": users,
    }


def fetch_sleeper_rosters(league_id: str = SLEEPER_LEAGUE_ID) -> List[Dict[str, Any]]:
    """
    Fetch all rosters for the league.
    """
    url = f"{SLEEPER_BASE_URL}/league/{league_id}/rosters"
    data = _http_get(url)
    if not isinstance(data, list):
        return []
    return data


def fetch_sleeper_players() -> Dict[str, Any]:
    """
    Fetch the full Sleeper NBA player pool.

    NOTE: This is a *large* payload but we only hit it once per update.
    """
    url = f"{SLEEPER_BASE_URL}/players/nba"
    data = _http_get(url)
    if not isinstance(data, dict):
        return {}
    return data


def fetch_sleeper_transactions(
    league_id: str = SLEEPER_LEAGUE_ID,
    max_weeks: int = 30,
) -> List[Dict[str, Any]]:
    """
    Fetch all transactions for the league, iterating over weeks 1..max_weeks.

    Sleeper's NBA season is usually shorter, but 30 is a safe cap.
    """
    all_tx: List[Dict[str, Any]] = []

    for week in range(1, max_weeks + 1):
        url = f"{SLEEPER_BASE_URL}/league/{league_id}/transactions/{week}"
        tx = _http_get(url)
        if isinstance(tx, list) and tx:
            all_tx.extend(tx)
        else:
            # If it's empty or not a list, just move on.
            continue

    print(f"Fetched {len(all_tx)} total transactions from Sleeper.")
    return all_tx


def fetch_sleeper_nba_metadata() -> Dict[str, Any]:
    """
    Wrapper to fetch Sleeper NBA player metadata.

    Kept separate so update_nba_historical.py has a clean import.
    """
    return fetch_sleeper_players()


# ---------------------------------------------------------------------------
# BallDontLie helpers – game logs & schedule
# ---------------------------------------------------------------------------


def fetch_nba_game_logs_since(
    start_date: dt.date,
    end_date: Optional[dt.date] = None,
) -> List[Dict[str, Any]]:
    """
    Fetch NBA box-score style game logs from BALLDONTLIE starting the day
    AFTER `start_date` up through `end_date` (inclusive).

    update_nba_historical.py passes in the last date present in
    the bundle and then appends whatever this function returns.
    """
    headers = _get_ball_dont_lie_headers()
    if not headers:
        # API key missing – let the caller decide what to do.
        return []

    if end_date is None:
        end_date = dt.date.today()

    logs: List[Dict[str, Any]] = []

    # We assume the caller passes the last date already in the bundle,
    # so we start at +1 day.
    current = start_date + dt.timedelta(days=1)

    while current <= end_date:
        date_str = current.isoformat()
        print(f"Fetching logs for {date_str}")

        params: Dict[str, Any] = {
            "dates[]": date_str,
            "per_page": 100,
        }

        while True:
            data = _http_get(
                f"{BALLDONTLIE_BASE_URL}/stats",
                params=params,
                headers=headers,
            )
            if not data or "data" not in data:
                break

            day_logs = data.get("data", [])
            if day_logs:
                logs.extend(day_logs)

            meta = data.get("meta") or {}
            next_cursor = meta.get("next_cursor")
            if next_cursor:
                # Cursor-based pagination
                params["cursor"] = next_cursor
            else:
                break

        current += dt.timedelta(days=1)

    print(f"Fetched {len(logs)} new game logs from BallDontLie.")
    return logs


def fetch_nba_schedule(season: int) -> List[Dict[str, Any]]:
    """
    Fetch NBA schedule for a given season using BALLDONTLIE `games` endpoint.

    This replaces the older data.nba.net schedule call, which can have
    SSL issues on some hosts.
    """
    headers = _get_ball_dont_lie_headers()
    if not headers:
        return []

    games: List[Dict[str, Any]] = []
    params: Dict[str, Any] = {
        "seasons[]": season,
        "per_page": 100,
    }

    while True:
        data = _http_get(
            f"{BALLDONTLIE_BASE_URL}/games", params=params, headers=headers
        )
        if not data or "data" not in data:
            break

        page_games = data.get("data", [])
        if page_games:
            games.extend(page_games)

        meta = data.get("meta") or {}
        next_cursor = meta.get("next_cursor")
        if next_cursor:
            params["cursor"] = next_cursor
        else:
            break

    print(f"Fetched {len(games)} games for season {season} from BallDontLie.")
    return games


# ---------------------------------------------------------------------------
# ESPN injuries
# ---------------------------------------------------------------------------


def fetch_espn_injuries() -> List[Dict[str, Any]]:
    """
    Fetch NBA injuries from ESPN's public site API and normalize into a
    simple list of dicts: one entry per injured player.

    Returned schema (per entry):

        {
            "player_id": str,
            "player_name": str,
            "position": str,
            "team_abbr": str,
            "team_name": str,
            "status": str,   # e.g. 'Out', 'Day-To-Day'
            "comment": str,
            "updated": str,  # ISO8601 or ESPN-style date string
        }
    """
    raw = _http_get(ESPN_INJURIES_URL)
    if not raw:
        print("Failed to fetch injuries from ESPN.")
        return []

    league = raw.get("league") or {}
    teams = league.get("teams") or []

    results: List[Dict[str, Any]] = []

    for team_entry in teams:
        team_info = team_entry.get("team") or {}
        team_abbr = team_info.get("abbreviation") or ""
        team_name = team_info.get("displayName") or team_info.get("name") or ""

        injuries = team_entry.get("injuries") or []
        for inj in injuries:
            athlete = inj.get("athlete") or {}
            status = inj.get("status") or {}
            status_type = status.get("type") or {}

            results.append(
                {
                    "player_id": str(athlete.get("id", "")),
                    "player_name": athlete.get("displayName") or "",
                    "position": (athlete.get("position") or {}).get("abbreviation", "")
                    if isinstance(athlete.get("position"), dict)
                    else "",
                    "team_abbr": team_abbr,
                    "team_name": team_name,
                    "status": status_type.get("name") or "",
                    "comment": status.get("details") or "",
                    "updated": status.get("updated") or "",
                }
            )

    print(f"Parsed {len(results)} ESPN injuries.")
    return results
