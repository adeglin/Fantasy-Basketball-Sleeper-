import json
import os
from datetime import datetime, date, timedelta
from typing import Any, Dict, List

import requests

# ================================
# CONFIG – EDIT THIS
# ================================
# Set this to your Sleeper NBA league ID (string)
LEAGUE_ID = "1202885172400234496"

# NBA season year for schedule (e.g., 2024 for 2024-25 season)
NBA_SEASON_YEAR = 2025

# Path to the JSON bundle (repo root)
BUNDLE_PATH = os.path.join("docs", "data", "nba_historical.json")


# ================================
# HELPERS – BUNDLE LOAD/SAVE
# ================================
def load_existing_bundle() -> Dict[str, Any]:
    if not os.path.exists(BUNDLE_PATH):
        return {
            "meta": {
                "last_updated": None,
                "last_game_date": None,
            },
            "league": {
                "info": {},
                "users": {},
                "rosters": [],
                "transactions": [],
                "players": {},
            },
            "nba": {
                "games": [],
                "schedule": [],
                "injuries": [],
                "players": {},
                "historical_stats": [],
            },
        }

    with open(BUNDLE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_bundle(bundle: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(BUNDLE_PATH), exist_ok=True)
    with open(BUNDLE_PATH, "w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=2, sort_keys=False)
    print(f"Bundle saved to {BUNDLE_PATH}")


def get_last_game_date(bundle: Dict[str, Any]) -> date:
    games = bundle.get("nba", {}).get("games", [])
    dates: List[date] = []
    for g in games:
        d = g.get("game_date")
        if not d:
            continue
        try:
            dates.append(datetime.strptime(d, "%Y-%m-%d").date())
        except ValueError:
            continue
    if not dates:
        # fallback: early season start
        return date(NBA_SEASON_YEAR, 10, 1)
    return max(dates)


def merge_game_logs(bundle: Dict[str, Any], new_games: List[Dict[str, Any]]) -> None:
    existing_games = bundle["nba"].get("games", [])
    existing_ids = {g.get("game_id") for g in existing_games if g.get("game_id")}

    deduped = [g for g in new_games if g.get("game_id") not in existing_ids]
    if deduped:
        print(f"Merging {len(deduped)} new game logs.")
    else:
        print("No new game logs to merge.")

    bundle["nba"]["games"] = existing_games + deduped


# ================================
# SLEEPER FETCHES
# ================================
SLEEPER_BASE = "https://api.sleeper.app/v1"


def _get_json(url: str) -> Any:
    print(f"GET {url}")
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return resp.json()


def fetch_sleeper_league_info(league_id: str) -> Dict[str, Any]:
    return _get_json(f"{SLEEPER_BASE}/league/{league_id}")


def fetch_sleeper_rosters(league_id: str) -> List[Dict[str, Any]]:
    return _get_json(f"{SLEEPER_BASE}/league/{league_id}/rosters")


def fetch_sleeper_users(league_id: str) -> List[Dict[str, Any]]:
    return _get_json(f"{SLEEPER_BASE}/league/{league_id}/users")


def fetch_sleeper_players() -> Dict[str, Any]:
    # Sleeper NBA player pool
    return _get_json(f"{SLEEPER_BASE}/players/nba")


def fetch_sleeper_transactions(league_id: str, max_weeks: int = 30) -> List[Dict[str, Any]]:
    all_tx: List[Dict[str, Any]] = []
    for week in range(1, max_weeks + 1):
        url = f"{SLEEPER_BASE}/league/{league_id}/transactions/{week}"
        try:
            tx_week = _get_json(url)
        except requests.HTTPError as e:
            # If a week is out of range, Sleeper usually returns 404; just stop there
            if e.response is not None and e.response.status_code == 404:
                break
            else:
                print(f"Error fetching transactions for week {week}: {e}")
                continue
        if not tx_week:
            continue
        all_tx.extend(tx_week)
    print(f"Fetched {len(all_tx)} total transactions.")
    return all_tx


# ================================
# ESPN INJURIES
# ================================
def fetch_espn_injuries() -> List[Dict[str, Any]]:
    url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries"
    try:
        data = _get_json(url)
    except Exception as e:
        print(f"Failed to fetch ESPN injuries: {e}")
        return []

    injuries: List[Dict[str, Any]] = []
    for league in data.get("injuries", []):
        for team in league.get("teams", []):
            team_info = team.get("team", {})
            team_abbrev = team_info.get("abbreviation") or team_info.get("abbrev")
            for item in team.get("injuries", []):
                player = item.get("athlete", {}) or {}
                notes = item.get("details") or item.get("comment") or ""
                status = item.get("status") or {}
                injuries.append(
                    {
                        "player_id": player.get("id"),
                        "name": player.get("displayName"),
                        "team": team_abbrev or "N/A",
                        "status": status.get("type", {}).get("name") or status.get("description"),
                        "detail": notes,
                        "source": "ESPN",
                    }
                )
    print(f"Parsed {len(injuries)} ESPN injuries.")
    return injuries


# ================================
# NBA SCHEDULE VIA CDN
# ================================
def fetch_nba_schedule(season_year: int) -> List[Dict[str, Any]]:
    # NBA data API – schedule JSON
    url = f"https://data.nba.net/prod/v2/{season_year}/schedule.json"
    try:
        data = _get_json(url)
    except Exception as e:
        print(f"Failed to fetch NBA schedule: {e}")
        return []

    games = data.get("league", {}).get("standard", [])
    schedule: List[Dict[str, Any]] = []

    for g in games:
        # Game date in yyyymmdd format
        gdte = g.get("startDateEastern")  # e.g., "20241024"
        game_date = None
        if gdte and len(gdte) == 8:
            game_date = f"{gdte[0:4]}-{gdte[4:6]}-{gdte[6:8]}"

        schedule.append(
            {
                "game_id": g.get("gameId"),
                "game_date": game_date,
                "home_team": g.get("hTeam", {}).get("teamId"),
                "away_team": g.get("vTeam", {}).get("teamId"),
                "status": g.get("statusNum"),
            }
        )

    print(f"Fetched {len(schedule)} NBA schedule entries.")
    return schedule


# ================================
# GAME LOGS (BallDontLie stub)
# ================================
def fetch_nba_game_logs_since(start_date: date) -> List[Dict[str, Any]]:
    """
    Incremental game-logs fetch using BallDontLie v2.
    Requires BALLDONTLIE_API_KEY in environment.
    If not set or request fails, returns [] but does NOT raise.
    """
    api_key = os.getenv("BALLDONTLIE_API_KEY")
    if not api_key:
        print("BALLDONTLIE_API_KEY not set; skipping game log fetch.")
        return []

    headers = {"Authorization": f"Bearer {api_key}"}
    base_url = "https://api.balldontlie.io/v1/stats"

    today = date.today()
    cur = start_date
    all_logs: List[Dict[str, Any]] = []

    while cur <= today:
        date_str = cur.strftime("%Y-%m-%d")
        params = {"dates[]": date_str, "per_page": 100}
        try:
            print(f"Fetching logs for {date_str}")
            resp = requests.get(base_url, headers=headers, params=params, timeout=20)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"Failed to fetch logs for {date_str}: {e}")
            cur += timedelta(days=1)
            continue

        for stat in data.get("data", []):
            game = stat.get("game", {})
            game_id = game.get("id")
            game_date = game.get("date", "")[:10]  # ISO string

            all_logs.append(
                {
                    "game_id": str(game_id),
                    "game_date": game_date,
                    "player_id": str(stat.get("player", {}).get("id")),
                    "team_id": str(stat.get("team", {}).get("id")),
                    "pts": stat.get("pts"),
                    "reb": stat.get("reb"),
                    "ast": stat.get("ast"),
                    "blk": stat.get("blk"),
                    "stl": stat.get("stl"),
                    "fg3m": stat.get("fg3m"),
                    "min": stat.get("min"),
                    "raw": stat,  # keep full object for now
                }
            )

        cur += timedelta(days=1)

    print(f"Fetched {len(all_logs)} new game logs.")
    return all_logs


# ================================
# MAIN PIPELINE
# ================================
def main() -> None:
    if LEAGUE_ID == "YOUR_SLEEPER_LEAGUE_ID":
        raise RuntimeError("Set LEAGUE_ID in tools/update_nba_historical.py before running.")

    bundle = load_existing_bundle()

    # ---- Incremental game logs ----
    last_game_date = get_last_game_date(bundle)
    print(f"Last game date in bundle: {last_game_date}")
    new_games = fetch_nba_game_logs_since(last_game_date + timedelta(days=1))
    if new_games:
        merge_game_logs(bundle, new_games)

    # ---- NBA schedule ----
    bundle["nba"]["schedule"] = fetch_nba_schedule(NBA_SEASON_YEAR)

    # ---- Sleeper league + rosters + users ----
    try:
        league_info = fetch_sleeper_league_info(LEAGUE_ID)
        users_list = fetch_sleeper_users(LEAGUE_ID)
        rosters_list = fetch_sleeper_rosters(LEAGUE_ID)
        transactions_list = fetch_sleeper_transactions(LEAGUE_ID)
        players_dict = fetch_sleeper_players()
    except Exception as e:
        # If Sleeper is down, fail the job (we actually want this to be visible)
        raise RuntimeError(f"Failed to fetch Sleeper data: {e}") from e

    # Map users by user_id for easy frontend lookup
    users_by_id = {}
    for u in users_list:
        uid = u.get("user_id")
        if uid:
            users_by_id[uid] = u

    bundle["league"]["info"] = league_info
    bundle["league"]["users"] = users_by_id
    bundle["league"]["rosters"] = rosters_list
    bundle["league"]["transactions"] = transactions_list
    bundle["league"]["players"] = players_dict

    # ---- ESPN injuries ----
    bundle["nba"]["injuries"] = fetch_espn_injuries()

    # ---- NBA metadata (from Sleeper players for now) ----
    # Just copy the Sleeper NBA player pool so frontend has player metadata
    bundle["nba"]["players"] = players_dict

    # ---- Meta fields ----
    bundle["meta"]["last_updated"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    # after merging, recompute last_game_date
    bundle["meta"]["last_game_date"] = get_last_game_date(bundle).strftime("%Y-%m-%d")

    save_bundle(bundle)
    print("Update complete.")


if __name__ == "__main__":
    main()
