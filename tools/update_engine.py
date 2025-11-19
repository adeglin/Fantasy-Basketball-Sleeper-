import os
import json
import math
from datetime import datetime, timedelta, date

from fetch_data import (
    fetch_nba_boxscores_for_date,
    fetch_sleeper_league,
    fetch_sleeper_users,
    fetch_sleeper_rosters,
    fetch_sleeper_transactions,
    fetch_sleeper_players,
    fetch_espn_injuries,
)

DEFAULT_BUNDLE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "docs",
    "data",
    "nba_historical.json",
)


def load_existing_bundle(path: str):
    """
    Load the existing JSON bundle if it exists, otherwise return a default structure.
    """
    if not os.path.exists(path):
        return {
            "last_game_date": None,
            "games": {},
            "sleeper": {},
            "injuries": [],
        }

    with open(path, "r") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError:
            # Corrupt or empty file – start fresh
            return {
                "last_game_date": None,
                "games": {},
                "sleeper": {},
                "injuries": [],
            }


def get_date_range_for_update(
    bundle: dict,
    max_days_back: int | None = None,
) -> tuple[date, date]:
    """
    Decide which dates to fetch.

    - If bundle has last_game_date, start from that + 1
    - Else, start from 10/01 of the current NBA season
    - Optionally cap the range to `max_days_back` days for testing
    """
    today = date.today()

    if bundle.get("last_game_date"):
        last = datetime.strptime(bundle["last_game_date"], "%Y-%m-%d").date()
        start = last + timedelta(days=1)
    else:
        # crude but fine: current season starts in October
        if today.month >= 10:
            season_start_year = today.year
        else:
            season_start_year = today.year - 1
        start = date(season_start_year, 10, 1)

    end = today  # up to today

    if max_days_back is not None:
        # Cap the start so we don’t go further back than max_days_back
        min_start = today - timedelta(days=max_days_back)
        if start < min_start:
            start = min_start

    if start > end:
        # nothing to do
        return end, end

    return start, end


def iter_dates(start: date, end: date):
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def run_update(
    output_path: str = DEFAULT_BUNDLE_PATH,
    test_mode: bool = False,
    max_days_back: int | None = None,
    sleeper_league_id: str | None = None,
):
    """
    Core engine used by both:
      - GitHub Actions (production)
      - Local test harness (test_mode=True)

    Parameters:
      - output_path: where to write the JSON bundle
      - test_mode: if True, we’re running locally, safe to be noisy/loggy,
                  and we can limit date ranges heavily
      - max_days_back: limit how many days of games to fetch (good for tests)
      - sleeper_league_id: your Sleeper league ID if you want league context
    """
    print(f"[ENGINE] Loading existing bundle from: {output_path}")
    bundle = load_existing_bundle(output_path)

    # Decide date range
    start_date, end_date = get_date_range_for_update(bundle, max_days_back=max_days_back)
    print(f"[ENGINE] Date range to fetch: {start_date} → {end_date}")

    if start_date > end_date:
        print("[ENGINE] No new dates to process.")
        return bundle

    # === 1. NBA games / boxscores ===
    any_games_added = False
    for d in iter_dates(start_date, end_date):
        ds = d.strftime("%Y-%m-%d")
        print(f"[ENGINE] Fetching NBA boxscores for {ds}...")
        try:
            games = fetch_nba_boxscores_for_date(ds)
        except Exception as e:
            print(f"  Failed to fetch stats for {ds}: {e}")
            continue

        if not games:
            print(f"  No games for {ds}")
            continue

        bundle.setdefault("games", {})[ds] = games
        bundle["last_game_date"] = ds
        any_games_added = True
        print(f"  Added {len(games)} games for {ds}")

    if not any_games_added:
        print("[ENGINE] No new NBA game logs to add.")
    else:
        print("[ENGINE] Finished NBA game update.")

    # === 2. Sleeper league data ===
    if sleeper_league_id:
        print("[ENGINE] Fetching Sleeper league data...")
        try:
            sleeper_data = fetch_sleeper_league_data(sleeper_league_id)
            bundle["sleeper"] = sleeper_data
            print("[ENGINE] Sleeper data updated.")
        except Exception as e:
            print(f"[ENGINE] Failed to fetch Sleeper data: {e}")

    # === 3. ESPN injuries ===
    print("[ENGINE] Fetching ESPN injuries...")
    try:
        injuries = fetch_espn_injuries()
        bundle["injuries"] = injuries
        print(f"[ENGINE] Injuries count: {len(injuries)}")
    except Exception as e:
        print(f"[ENGINE] Failed to fetch injuries: {e}")

    # === 4. Save ===
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    import math

    def _clean_nans(obj):
        if isinstance(obj, float) and math.isnan(obj):
            return None
        if isinstance(obj, dict):
            return {k: _clean_nans(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_clean_nans(x) for x in obj]
        return obj

    clean_bundle = _clean_nans(bundle)

    with open(output_path, "w") as f:
        json.dump(clean_bundle, f, indent=2, sort_keys=True)

    print(f"[ENGINE] Saved to {output_path}")

    return bundle



