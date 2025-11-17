"""
tools/update_nba_historical.py

Incrementally updates docs/data/nba_historical.json with:

- NBA boxscores for each date (using nba_api)
- Sleeper league/users/rosters/transactions/players
- ESPN injuries

Assumptions:
- Data file is at docs/data/nba_historical.json
- We keep a simple structure that the front end can adapt to.

If the file exists, we read it and continue from the last date we have.
If it doesn't exist, we start from a fixed start date.
"""

import json
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List

# -----------------------------------------------------------------------------
# Make sure fetch_data.py (at repo root) can be imported
# -----------------------------------------------------------------------------
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from fetch_data import (  # type: ignore
    fetch_nba_boxscores_for_date,
    fetch_sleeper_league,
    fetch_sleeper_users,
    fetch_sleeper_rosters,
    fetch_sleeper_transactions,
    fetch_sleeper_players,
    fetch_espn_injuries,
)

DATA_PATH = ROOT_DIR / "docs" / "data" / "nba_historical.json"


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

def _iso_today() -> str:
    return date.today().isoformat()


def _date_range(start: date, end: date):
    """Yield dates from start to end inclusive."""
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def _load_existing_bundle() -> Dict[str, Any]:
    if DATA_PATH.exists():
        with open(DATA_PATH, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                # If the file is corrupt, just start fresh
                pass

    # Fresh structure
    return {
        "meta": {
            "last_game_date": None,
            "updated_at": None,
            "schema_version": 1,
        },
        "nba": {
            "game_logs": [],  # list of boxscore objects
        },
        "sleeper": {
            "league": None,
            "users": [],
            "rosters": [],
            "transactions": [],
            "players": {},
        },
        "injuries": [],
    }


def _get_last_game_date(bundle: Dict[str, Any]) -> date:
    meta = bundle.get("meta", {})
    last_str = meta.get("last_game_date")
    if last_str:
        try:
            return date.fromisoformat(last_str)
        except ValueError:
            pass

    # If we have existing logs but no meta date, infer from them
    logs = bundle.get("nba", {}).get("game_logs", [])
    if logs:
        dates = []
        for log in logs:
            d = log.get("game_date")
            if d:
                try:
                    dates.append(date.fromisoformat(d))
                except ValueError:
                    continue
        if dates:
            return max(dates)

    # If completely fresh, start a bit in the past
    # You previously said: current season + last 3 years.
    # We'll just start from 3 seasons ago if needed.
    this_year = date.today().year
    start_year = this_year - 3
    # Roughly start from Oct 1 of that year (start of NBA season)
    return date(start_year, 10, 1)


# -----------------------------------------------------------------------------
# Main update logic
# -----------------------------------------------------------------------------

def main() -> None:
    print(f"Data file path: {DATA_PATH}")

    bundle = _load_existing_bundle()

    today = date.today()
    last_game_date = _get_last_game_date(bundle)

    # We start from the next day after last_game_date
    start_date = last_game_date + timedelta(days=1)
    end_date = today

    print(f"Last recorded game date: {last_game_date.isoformat()}")
    print(f"Updating from {start_date.isoformat()} to {end_date.isoformat()}")

    new_game_logs: List[Dict[str, Any]] = []

    if start_date <= end_date:
        for d in _date_range(start_date, end_date):
            ds = d.isoformat()
            print(f"Fetching NBA boxscores for {ds}...")
            try:
                day_logs = fetch_nba_boxscores_for_date(ds)
            except Exception as e:
                print(f"  Failed to fetch stats for {ds}: {e}")
                continue

            if not day_logs:
                print(f"  No game stats for {ds}")
                continue

            print(f"  Retrieved {len(day_logs)} games for {ds}")
            new_game_logs.extend(day_logs)

        if new_game_logs:
            bundle.setdefault("nba", {}).setdefault("game_logs", [])
            bundle["nba"]["game_logs"].extend(new_game_logs)
            # Update meta last_game_date to the last date we actually added logs for
            last_logged_date = new_game_logs[-1]["game_date"]
            bundle.setdefault("meta", {})
            bundle["meta"]["last_game_date"] = last_logged_date
        else:
            print("No new NBA game logs to add.")
    else:
        print("No new dates to update for NBA games.")

    # Always refresh Sleeper + injuries each run (cheap, and structure is small)
    print("Fetching Sleeper league data...")
    try:
        bundle.setdefault("sleeper", {})
        bundle["sleeper"]["league"] = fetch_sleeper_league()
        bundle["sleeper"]["users"] = fetch_sleeper_users()
        bundle["sleeper"]["rosters"] = fetch_sleeper_rosters()
        bundle["sleeper"]["transactions"] = fetch_sleeper_transactions()
        bundle["sleeper"]["players"] = fetch_sleeper_players()
    except Exception as e:
        print(f"Failed to fetch Sleeper data: {e}")

    print("Fetching ESPN injuries...")
    try:
        bundle["injuries"] = fetch_espn_injuries()
        print(f"Injuries count: {len(bundle['injuries'])}")
    except Exception as e:
        print(f"Failed to fetch ESPN injuries: {e}")

    # Update meta
    bundle.setdefault("meta", {})
    bundle["meta"]["updated_at"] = datetime.utcnow().isoformat() + "Z"

    # Ensure directory exists
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Write out
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump(bundle, f, indent=2, sort_keys=True)

    print("Update complete.")
    print(f"Saved to {DATA_PATH}")


if __name__ == "__main__":
    main()
