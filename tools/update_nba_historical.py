import os
import sys

# Ensure we can import fetch_data.py from the repo root
CURRENT_DIR = os.path.dirname(__file__)
REPO_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, os.pardir))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from fetch_data import (
    fetch_sleeper_league_metadata,
    fetch_sleeper_rosters,
    fetch_sleeper_players,
    fetch_sleeper_transactions,
    fetch_espn_injuries,
    fetch_nba_schedule,
    fetch_nba_game_logs_since,  # you may need to implement/rename this
    fetch_sleeper_nba_metadata,
)

BUNDLE_PATH = "docs/data/nba_historical.json"


def load_existing_bundle():
    if not os.path.exists(BUNDLE_PATH):
        return {
            "meta": {
                "last_updated": None,
                "last_game_date": None,
            },
            "league": {
                "info": {},
                "users": {},
                "rosters": {},
                "transactions": [],
                "players": {},
            },
            "nba": {
                "games": [],              # list of game logs
                "schedule": [],
                "injuries": [],
                "players": {},
                "historical_stats": [],
            },
        }
    with open(BUNDLE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def get_last_game_date(bundle):
    games = bundle.get("nba", {}).get("games", [])
    if not games:
        # if none, start a bit before season tipoff
        return date(2024, 10, 1)  # adjust season start if needed

    # assume games have a 'game_date' field
    dates = []
    for g in games:
        d = g.get("game_date")
        if d:
            try:
                dates.append(datetime.strptime(d, "%Y-%m-%d").date())
            except ValueError:
                pass
    if not dates:
        return date(2024, 10, 1)
    return max(dates)


def merge_game_logs(bundle, new_games):
    existing_games = bundle["nba"].get("games", [])
    existing_ids = {g["game_id"] for g in existing_games if "game_id" in g}

    deduped_new = [g for g in new_games if g.get("game_id") not in existing_ids]
    bundle["nba"]["games"] = existing_games + deduped_new
    return bundle


def main():
    bundle = load_existing_bundle()
    last_game_date = get_last_game_date(bundle)
    today = date.today()

    # 1) NBA GAMES & SCHEDULE
    # fetch only games after last_game_date
    new_games = fetch_nba_game_logs_since(last_game_date + timedelta(days=1))
    schedule = fetch_nba_schedule()  # often a full-season JSON

    bundle = merge_game_logs(bundle, new_games)
    bundle["nba"]["schedule"] = schedule

    # 2) LEAGUE DATA
    league_meta = fetch_sleeper_league_metadata()
    rosters = fetch_sleeper_rosters()
    players = fetch_sleeper_players()
    transactions = fetch_sleeper_transactions()

    bundle["league"]["info"] = league_meta

    # map users by user_id for lookup on frontend
    users = {u["user_id"]: u for u in league_meta.get("users", [])} if "users" in league_meta else {}
    bundle["league"]["users"] = users

    bundle["league"]["rosters"] = rosters
    bundle["league"]["players"] = players
    bundle["league"]["transactions"] = transactions

    # 3) INJURIES (parse team correctly)
    injuries_raw = fetch_espn_injuries()
    injuries = []
    for inj in injuries_raw:
        injuries.append({
            "player_id": inj.get("id") or inj.get("playerId"),
            "name": inj.get("name"),
            "team": (inj.get("team") or {}).get("abbrev") or inj.get("teamAbbrev") or "N/A",
            "status": inj.get("status"),
            "detail": inj.get("details") or inj.get("comment"),
            "source": "ESPN",
        })
    bundle["nba"]["injuries"] = injuries

    # 4) METADATA
    sleeper_nba_meta = fetch_sleeper_nba_metadata()
    bundle["nba"]["players"] = sleeper_nba_meta.get("players", {})

    bundle["meta"]["last_updated"] = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    bundle["meta"]["last_game_date"] = get_last_game_date(bundle).strftime("%Y-%m-%d")

    # 5) WRITE OUT
    os.makedirs(os.path.dirname(BUNDLE_PATH), exist_ok=True)
    with open(BUNDLE_PATH, "w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=2, sort_keys=False)

    print("Updated bundle written to", BUNDLE_PATH)


if __name__ == "__main__":
    main()
