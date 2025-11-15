import os
import json
from datetime import date, timedelta, datetime

import requests

# -----------------------------
# Configuration
# -----------------------------

SLEEPER_BASE_URL = "https://api.sleeper.app/v1"
SLEEPER_LEAGUE_ID = "1202885172400234496"  # your league

BALLDONTLIE_BASE_URL = "https://api.balldontlie.io/v1"
ESPN_INJURIES_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"

# NBA schedule (this host has a funky cert; we treat failures as non-fatal)
NBA_SCHEDULE_URL_TEMPLATE = "https://data.nba.net/prod/v2/{season_year}/schedule.json"


# -----------------------------
# Helpers
# -----------------------------

def _get_ball_dontlie_headers():
    """
    Build headers for BallDontLie.

    IMPORTANT: Docs say the key must be in the header exactly as:
        Authorization: YOUR_API_KEY
    NOT "Bearer ..." – just the raw key.
    """
    api_key = os.environ.get("BALLDONTLIE_API_KEY")
    if not api_key:
        return None
    return {
        "Authorization": api_key
    }


def _season_year_for_today():
    """Very simple season-year heuristic: if month >= 8, treat as that year, else previous year."""
    today = date.today()
    if today.month >= 8:
        return today.year
    return today.year - 1


# -----------------------------
# BallDontLie game logs
# -----------------------------

def fetch_nba_game_logs_since(start_date: date):
    """
    Fetch NBA game logs from BallDontLie starting (inclusive) at start_date up to today.

    Uses /v1/stats with dates[] filter.
    NOTE: This only fetches the first page (per_page=100) per day.
    For most fantasy usage that's fine; you can extend later to follow meta.next_cursor.
    """
    headers = _get_ball_dontlie_headers()
    if not headers:
        print("BALLDONTLIE_API_KEY not set; skipping game log fetch.")
        return []

    logs = []
    today = date.today()
    current = start_date

    while current <= today:
        iso = current.isoformat()
        print(f"Fetching logs for {iso}")
        params = {
            "dates[]": iso,
            "per_page": 100,  # first page; extend later with cursor if needed
        }
        url = f"{BALLDONTLIE_BASE_URL}/stats"

        try:
            resp = requests.get(url, headers=headers, params=params, timeout=20)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"Failed to fetch logs for {iso}: {e}")
            current += timedelta(days=1)
            continue

        payload = resp.json() or {}
        day_logs = payload.get("data", [])
        logs.extend(day_logs)

        # TODO: handle pagination if meta.next_cursor present
        # meta = payload.get("meta") or {}
        # next_cursor = meta.get("next_cursor")

        current += timedelta(days=1)

    print(f"Fetched {len(logs)} new game logs.")
    return logs


# -----------------------------
# NBA schedule (NBA JSON CDN)
# -----------------------------

def fetch_nba_schedule():
    """
    Fetch NBA schedule from data.nba.net.

    data.nba.net currently uses a cert with a hostname mismatch for 'data.nba.net'
    on some environments, which can cause SSL errors. We catch and log but don't crash.
    """
    season_year = _season_year_for_today()
    url = NBA_SCHEDULE_URL_TEMPLATE.format(season_year=season_year)
    print(f"GET {url}")

    try:
        # If cert errors keep annoying you, you *could* use verify=False,
        # but that's less secure. For now we keep verify=True and just log failures.
        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"Failed to fetch NBA schedule: {e}")
        return []

    try:
        data = resp.json()
    except Exception as e:
        print(f"Failed to parse NBA schedule JSON: {e}")
        return []

    # The exact structure isn't critical here; we just return whatever JSON gives.
    return data


# -----------------------------
# Sleeper league data
# -----------------------------

def fetch_sleeper_league_metadata():
    """Return league object with an added 'users' key."""
    league_url = f"{SLEEPER_BASE_URL}/league/{SLEEPER_LEAGUE_ID}"
    users_url = f"{SLEEPER_BASE_URL}/league/{SLEEPER_LEAGUE_ID}/users"

    print(f"GET {league_url}")
    league_resp = requests.get(league_url, timeout=20)
    league_resp.raise_for_status()
    league = league_resp.json()

    print(f"GET {users_url}")
    users_resp = requests.get(users_url, timeout=20)
    users_resp.raise_for_status()
    users = users_resp.json()

    league["users"] = users
    return league


def fetch_sleeper_rosters():
    """Return list of Sleeper rosters for your league."""
    url = f"{SLEEPER_BASE_URL}/league/{SLEEPER_LEAGUE_ID}/rosters"
    print(f"GET {url}")
    resp = requests.get(url, timeout=20)
    resp.raise_for_status()
    return resp.json()


def fetch_sleeper_transactions(max_weeks: int = 30):
    """
    Fetch all transactions from week 1..max_weeks (inclusive).
    Sleeper uses /transactions/{week}.
    """
    all_tx = []
    for week in range(1, max_weeks + 1):
        url = f"{SLEEPER_BASE_URL}/league/{SLEEPER_LEAGUE_ID}/transactions/{week}"
        print(f"GET {url}")
        try:
            resp = requests.get(url, timeout=20)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"Failed to fetch transactions for week {week}: {e}")
            continue

        data = resp.json() or []
        if data:
            all_tx.extend(data)

    print(f"Fetched {len(all_tx)} total transactions.")
    return all_tx


def fetch_sleeper_players():
    """
    Fetch Sleeper's NBA player pool.

    Endpoint: /players/nba
    Returns a big dict keyed by player_id.
    """
    url = f"{SLEEPER_BASE_URL}/players/nba"
    print(f"GET {url}")
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    return resp.json()


def fetch_sleeper_nba_metadata():
    """
    Thin wrapper to keep compatibility with update_nba_historical.py.
    Currently just returns the same structure as fetch_sleeper_players.
    """
    players = fetch_sleeper_players()
    return {"players": players}


# -----------------------------
# ESPN injuries
# -----------------------------

def fetch_espn_injuries():
    """
    Fetch ESPN injuries JSON raw.

    We'll parse/normalize it in update_nba_historical.py.
    """
    print(f"GET {ESPN_INJURIES_URL}")
    try:
        resp = requests.get(ESPN_INJURIES_URL, timeout=20)
        resp.raise_for_status()
    except requests.RequestException as e:
        print(f"Failed to fetch ESPN injuries: {e}")
        return {}

    try:
        return resp.json()
    except Exception as e:
        print(f"Failed to parse ESPN injuries JSON: {e}")
        return {}
