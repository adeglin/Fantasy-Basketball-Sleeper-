import os
import json
from datetime import datetime, timedelta
from fetch_data import fetch_games_for_date

OUTPUT_PATH = "docs/data/nba_historical.json"

SEASONS_TO_INCLUDE = 4  # current + last 3


def date_range(start, end):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def load_existing():
    if not os.path.exists(OUTPUT_PATH):
        return {
            "players": {},
            "season_stats": {},
            "game_logs": {},
            "games": {}
        }

    with open(OUTPUT_PATH, "r") as f:
        return json.load(f)


def safe_add_stats(old, new):
    for k, v in new.items():
        try:
            old[k] = old.get(k, 0) + int(v)
        except:
            pass


def main():
    bundle = load_existing()

    current_year = datetime.now().year
    start_year = current_year - 3

    years = list(range(start_year, current_year + 1))

    for year in years:
        print(f"=== Fetching season {year} ===")

        # Season-level structures
        if str(year) not in bundle["season_stats"]:
            bundle["season_stats"][str(year)] = {}
        if str(year) not in bundle["game_logs"]:
            bundle["game_logs"][str(year)] = {}

        # NBA regular season approx (Oct → Jun)
        start = datetime(year, 10, 1)
        end = datetime(year + 1, 6, 30)

        for d in date_range(start, end):
            ds = d.strftime("%Y-%m-%d")
            ds_int = d.strftime("%Y%m%d")

            print(f"Fetching {ds}...")

            games = fetch_games_for_date(ds_int)
            if not games:
                continue

            for g in games:
                gid = g["game_id"]

                bundle["games"][gid] = g

                for pid, pdata in g["players"].items():

                    # player container
                    if pid not in bundle["players"]:
                        bundle["players"][pid] = {
                            "name": pid,
                            "team_history": {}
                        }

                    # GAME LOGS
                    if pid not in bundle["game_logs"][str(year)]:
                        bundle["game_logs"][str(year)][pid] = {}
                    bundle["game_logs"][str(year)][pid][ds] = pdata["stats"]

                    # SEASON AGG
                    if pid not in bundle["season_stats"][str(year)]:
                        bundle["season_stats"][str(year)][pid] = {}

                    safe_add_stats(
                        bundle["season_stats"][str(year)][pid],
                        pdata["stats"]
                    )

    # Write final bundle
    with open(OUTPUT_PATH, "w") as f:
        json.dump(bundle, f, indent=2)

    print("✔ Update complete.")


if __name__ == "__main__":
    main()
