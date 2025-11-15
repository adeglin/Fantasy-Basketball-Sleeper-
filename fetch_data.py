import os
import time
import datetime as dt
from typing import Any, Dict, List, Optional

import requests

# -----------------------------
# Constants / Config
# -----------------------------

SLEEPER_LEAGUE_ID = "1202885172400234496"
SLEEPER_BASE = "https://api.sleeper.app/v1"

BALLDONTLIE_BASE = "https://api.balldontlie.io/v1"
ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"

# If this causes SSL issues on your VPS, update the schedule function below
NBA_SCHEDULE_URL_TEMPLATE = "https://data.nba.net/prod/v2/{season}/schedule.json"


# -----------------------------
# Helpers
# -----------------------------------------

def _balldontlie_headers() -> Dict[str, str]:
    """
    Build headers for BallDontLie API using env var BALLDONTLIE_API_KEY.

    401s from the API usually mean:
      - Missing/incorrect API key, OR
      - Your account tier does not include the endpoint (e.g., /stats).
    """
    api_key = os.getenv("BALLDONTLIE_API_KEY")
    if not api_key:
        print("BALLDONTLIE_API_KEY not set; skipping game log fetch.")
        return {}

    # Per BallDontLie docs: header must be Authorization: YOUR_API_KEY
    # (no 'Bearer' prefix).
    return {"Authorization": api_key}


def _safe_get(url: str, *, params: Optional[Dict[str, Any]] = None,
              headers: Optional[Dict[str, str]] = None,
              timeout: int = 30) -> Optional[requests.Response]:
    """Simple wrapper that logs and swallows errors instead of crashing."""
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=timeout)
        resp.raise_for_status()
        return resp
    except requests.HTTPError as e:
        print(f"HTTP error for {url}: {e}")
    except Exception as e:
        print(f"Error requesting {url}: {e}")
    return None


# -----------------------------
# Sleeper league / rosters / transactions / players
# -----------------------------

def fetch_sleeper_league_metadata() -> Dict[str, Any]:
    """Return basic league metadata + users."""
    league_url = f"{SLEEPER_BASE}/league/{SLEEPER_LEAGUE_ID}"
    users_url = f"{SLEEPER_BASE}/league/{SLEEPER_LEAGUE_ID}/users"

    league_resp = _safe_get(league_url)
    users_resp = _safe_get(users_url)

    league = league_resp.json() if league_resp is not None else {}
    users = users_resp.json() if users_resp is not None else []

    print(f"Fetched Sleeper league metadata (league: {bool(league)}, users: {len(users)})")

    return {
        "league": league,
        "users": users,
    }


def fetch_sleeper_rosters() -> List[Dict[str, Any]]:
    """Return list of Sleeper rosters for the league."""
    url = f"{SLEEPER_BASE}/league/{SLEEPER_LEAGUE_ID}/rosters"
    resp = _safe_get(url)
    rosters = resp.json() if resp is not None else []
    print(f"Fetched {len(rosters)} Sleeper rosters.")
    return rosters


def fetch_sleeper_players() -> Dict[str, Any]:
    """
    Return the full Sleeper NBA player pool.

    This is a big dict keyed by Sleeper player_id.
    """
    url = f"{SLEEPER_BASE}/players/nba"
    resp = _safe_get(url)
    players = resp.json() if resp is not None else {}
    print(f"Fetched {len(players)} Sleeper players.")
    return players


def fetch_sleeper_transactions(max_weeks: int = 30) -> List[Dict[str, Any]]:
    """
    Fetch league transactions for weeks 1..max_weeks.

    Sleeper's NBA "weeks" are just internal periods; this mirrors what we
    saw in your logs (1–30).
    """
    all_tx: List[Dict[str, Any]] = []

    for week in range(1, max_weeks + 1):
        url = f"{SLEEPER_BASE}/league/{SLEEPER_LEAGUE_ID}/transactions/{week}"
        resp = _safe_get(url)
        if resp is None:
            continue

        week_tx = resp.json() or []
        if week_tx:
            print(f"Week {week}: fetched {len(week_tx)} transactions.")
            all_tx.extend(week_tx)

    print(f"Fetched {len(all_tx)} total transactions.")
    return all_tx


def fetch_sleeper_nba_metadata() -> Dict[str, Any]:
    """
    Thin wrapper over Sleeper NBA players endpoint.

    You can treat this as "NBA metadata" for mapping player IDs, positions,
    teams, etc.
    """
    return fetch_sleeper_players()


# -----------------------------
# BallDontLie NBA game logs (incremental)
# -----------------------------

def fetch_nba_game_logs_for_date(date_obj: dt.date) -> List[Dict[str, Any]]:
    """
    Fetch all player game logs for a single date via BallDontLie /v1/stats.

    Uses cursor-based pagination as documented by BallDontLie:
      - per_page up to 100
      - meta.next_cursor for subsequent pages
    """
    headers = _balldontlie_headers()
    if not headers:
        # Already logged missing API key.
        return []

    date_str = date_obj.isoformat()
    print(f"Fetching logs for {date_str}")

    url = f"{BALLDONTLIE_BASE}/stats"
    all_logs: List[Dict[str, Any]] = []
    cursor: Optional[int] = None

    while True:
        params: Dict[str, Any] = {
            "dates[]": date_str,
            "per_page": 100,
        }
        if cursor is not None:
            params["cursor"] = cursor

        resp = _safe_get(url, params=params, headers=headers)
        if resp is None:
            # Could be network error, HTTP error, etc.
            # If it's HTTP 401 specifically, log once and bail out for the entire date.
            try:
                # If we had a response but it raised on .raise_for_status(), _safe_get
                # would already have printed it. To be extra explicit:
                if resp is not None and resp.status_code == 401:
                    print(
                        "Got 401 from BallDontLie. "
                        "Make sure BALLDONTLIE_API_KEY is set AND your account tier "
                        "includes the /stats endpoint (game player stats)."
                    )
            except Exception:
                pass
            break

        data = resp.json()
        logs = data.get("data", [])
        all_logs.extend(logs)

        meta = data.get("meta", {}) or {}
        cursor = meta.get("next_cursor")
        if not cursor:
            break

        # Small pause to be nice to the API
        time.sleep(0.2)

    print(f"Fetched {len(all_logs)} logs for {date_str}")
    return all_logs


def fetch_nba_game_logs_since(start_date: dt.date,
                              end_date: Optional[dt.date] = None) -> List[Dict[str, Any]]:
    """
    Fetch player game logs from BallDontLie from start_date (inclusive)
    up to end_date (inclusive, default = today).

    Returns a flat list of BallDontLie stat objects.
    """
    if end_date is None:
        end_date = dt.date.today()

    all_logs: List[Dict[str, Any]] = []
    cur = start_date

    while cur <= end_date:
        day_logs = fetch_nba_game_logs_for_date(cur)
        all_logs.extend(day_logs)
        cur += dt.timedelta(days=1)

    print(f"Fetched {len(all_logs)} new game logs in total.")
    return all_logs


# -----------------------------
# NBA schedule (best-effort)
# -----------------------------

def fetch_nba_schedule(season_year: Optional[int] = None) -> Dict[str, Any]:
    """
    Fetch NBA schedule from data.nba.net.

    If SSL issues occur on your VPS, this function will simply log and
    return an empty dict (so the rest of the pipeline still works).
    """
    if season_year is None:
        today = dt.date.today()
        season_year = today.year

    url = NBA_SCHEDULE_URL_TEMPLATE.format(season=season_year)

    try:
        # If this still fails due to SSL on your VPS, we catch it.
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        print(f"Fetched NBA schedule for season {season_year}.")
        return data
    except Exception as e:
        print(f"Failed to fetch NBA schedule: {e}")
        return {}


# -----------------------------
# ESPN injuries
# -----------------------------

def fetch_espn_injuries() -> Dict[str, Any]:
    """
    Fetch raw ESPN injuries payload.

    We'll keep this simple and return the full JSON. The frontend or
    update_nba_historical.py can decide how to parse it.

    ESPN's structure can change, so this is safer than overfitting.
    """
    resp = _safe_get(ESPN_INJURIES_URL)
    if resp is None:
        print("Failed to fetch ESPN injuries.")
        return {}

    data = resp.json()
    # For logging/debugging only
    total_items = len(data.get("injuries", [])) if isinstance(data.get("injuries", []), list) else 0
    print(f"Fetched ESPN injuries payload (top-level 'injuries' count: {total_items}).")
    return data
