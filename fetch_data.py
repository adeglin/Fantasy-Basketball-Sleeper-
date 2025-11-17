import requests
import time
from datetime import datetime
from functools import lru_cache

ESPN_SCHEDULE_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
ESPN_GAMECAST_URL = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary"
DOUG_BOX_URL = "https://www.dougstats.com"  # HTML parsing fallback

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; FantasyBot/1.0)"
}


def safe_get(url, params=None):
    """Perform GET with retry + timeout."""
    for _ in range(3):
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=15)
            if resp.status_code == 200:
                return resp
        except Exception:
            time.sleep(1)
    return None


def fetch_espn_games_for_date(date_str):
    """
    Fetch ESPN scoreboard for a specific date (YYYYMMDD format).
    Returns list of game IDs.
    """
    resp = safe_get(ESPN_SCHEDULE_URL, params={"dates": date_str})
    if not resp:
        return []

    data = resp.json()
    events = data.get("events", [])
    game_ids = [e["id"] for e in events if "id" in e]
    return game_ids


def fetch_espn_gamecast(game_id):
    """
    Fetch complete ESPN Gamecast (box score, scoring plays, teams, players).
    """
    url = f"{ESPN_GAMECAST_URL}/{game_id}"
    resp = safe_get(url)
    if not resp:
        return None

    return resp.json()


def normalize_espn_box(game_json):
    """
    Convert ESPN summary → standardized flat boxscore.
    Output format:
    {
        "game_id": ...,
        "date": ...,
        "home_team": "...",
        "away_team": "...",
        "players": {
            "player_id": {
                "team": "...",
                "stats": {...}
            }
        }
    }
    """
    if not game_json:
        return None

    header = game_json.get("header", {})
    competitions = header.get("competitions", [{}])[0]

    home_team = competitions["competitors"][0]["team"]["shortDisplayName"]
    away_team = competitions["competitors"][1]["team"]["shortDisplayName"]
    date = header.get("competitions", [{}])[0].get("date", "")

    result = {
        "game_id": header.get("id"),
        "date": date[:10],
        "home_team": home_team,
        "away_team": away_team,
        "players": {}
    }

    # Extract player box score
    box = game_json.get("boxscore", {})
    for team in box.get("players", []):
        team_name = team.get("team", {}).get("shortDisplayName")
        for player in team.get("statistics", []):
            pid = player.get("athlete", {}).get("id")
            if not pid:
                continue

            stats = {}
            for cat in player.get("stats", []):
                parts = cat.split(":")
                if len(parts) == 2:
                    key = parts[0].strip()
                    val = parts[1].strip()
                    stats[key] = val

            result["players"][pid] = {
                "team": team_name,
                "stats": stats
            }

    return result


###########################################
# DOUGSTATS FALLBACK PARSER (LIGHT)
###########################################

def fetch_doug_box(date_str):
    """
    Fetch DougStats HTML box score for a given date.
    We only parse minimal data (points, rebounds, assists).
    """
    yyyy, mm, dd = date_str[:4], date_str[4:6], date_str[6:]
    url = f"{DOUG_BOX_URL}/{yyyy}-{mm}-{dd}.html"

    resp = safe_get(url)
    if not resp:
        return None

    # WE KEEP THIS SIMPLE: extract <pre> block
    html = resp.text
    if "<pre>" not in html:
        return None

    # Minimal parse: name + PTS + TRB + AST
    lines = html.split("\n")
    players = {}
    for line in lines:
        parts = line.split()
        if len(parts) < 4:
            continue
        name = parts[0]
        try:
            pts = int(parts[-3])
            reb = int(parts[-2])
            ast = int(parts[-1])
        except:
            continue

        players[name] = {
            "team": None,
            "stats": {
                "PTS": pts,
                "REB": reb,
                "AST": ast
            }
        }

    return players if players else None


###########################################
# MASTER FETCH FUNCTION
###########################################

def fetch_games_for_date(date_str):
    """
    Returns standardized boxscores (ESPN → normalized; Doug fallback if needed).
    """
    game_ids = fetch_espn_games_for_date(date_str)
    results = []

    for gid in game_ids:
        raw = fetch_espn_gamecast(gid)
        normalized = normalize_espn_box(raw)

        if normalized:
            results.append(normalized)
            continue

        # fallback: DougStats
        doug = fetch_doug_box(date_str)
        if doug:
            results.append({
                "game_id": f"DOUG-{date_str}",
                "date": date_str,
                "home_team": None,
                "away_team": None,
                "players": doug
            })

    return results
