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
            "meta": {},
            "nba": {"seasons": {}},
        }

    with open(path, "r") as f:
        try:
            bundle = json.load(f)
        except json.JSONDecodeError:
            # Corrupt or empty file – start fresh
            return {
                "last_game_date": None,
                "games": {},
                "sleeper": {},
                "injuries": [],
                "meta": {},
                "nba": {"seasons": {}},
            }

    # Ensure required top-level keys exist
    bundle.setdefault("last_game_date", None)
    bundle.setdefault("games", {})
    bundle.setdefault("sleeper", {})
    bundle.setdefault("injuries", [])
    bundle.setdefault("meta", {})
    bundle.setdefault("nba", {})
    bundle["nba"].setdefault("seasons", {})

    return bundle


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


def _determine_season_key_from_date(d: date) -> str:
    """
    Turn a game date into a season key like '2025-26'.
    """
    if d.month >= 10:
        start_year = d.year
    else:
        start_year = d.year - 1
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def _build_nba_seasons_from_games(bundle: dict) -> None:
    """
    Take bundle["games"][YYYY-MM-DD] lists of boxscore rows and normalize them into
    the structure the frontend expects:

      bundle["nba"]["seasons"][season_key]["game_logs"] = [...]
      bundle["nba"]["seasons"][season_key]["season_stats"] = [...]

    We assume each row already looks like a player game-log with
    fields like GAME_DATE, PLAYER_ID, PLAYER_NAME, TEAM_ABBREVIATION, MIN, PTS, etc.
    """
    games = bundle.get("games", {}) or {}
    seasons: dict[str, dict] = {}

    all_logs = []

    for date_str, logs_for_day in games.items():
        # logs_for_day is expected to be a list of player boxscore dicts
        for g in logs_for_day or []:
            # Ensure GAME_DATE is populated
            if not g.get("GAME_DATE"):
                g = dict(g)  # shallow copy so we don't mutate shared objects
                g["GAME_DATE"] = date_str
            all_logs.append(g)

    # Group logs by season
    for g in all_logs:
        # Prefer explicit season field if present
        season_year = g.get("SEASON_YEAR")
        if isinstance(season_year, str):
            season_key = season_year
        elif isinstance(season_year, int):
            season_key = str(season_year)
        else:
            # Fallback: compute from GAME_DATE
            gd = g.get("GAME_DATE")
            try:
                d = datetime.strptime(gd, "%Y-%m-%d").date()
            except Exception:
                # If parsing fails, just skip this log
                continue
            season_key = _determine_season_key_from_date(d)

        season_block = seasons.setdefault(
            season_key, {"game_logs": [], "season_stats": []}
        )
        season_block["game_logs"].append(g)

    # Compute simple per-player season averages for each season
    for season_key, block in seasons.items():
        logs = block.get("game_logs", []) or []
        by_key = {}

        for g in logs:
            pid = g.get("PLAYER_ID") or g.get("player_id") or g.get("PLAYER_NAME") or ""
            team = (
                g.get("TEAM_ABBREVIATION")
                or g.get("TEAM_ABBR")
                or g.get("TEAM")
                or ""
            )
            key = f"{pid}|{team}"

            rec = by_key.get(key)
            if not rec:
                rec = {
                    "PLAYER_ID": pid,
                    "PLAYER_NAME": g.get("PLAYER_NAME") or g.get("player_name") or "",
                    "TEAM_ABBREVIATION": team,
                    "GP": 0,
                    "MIN": 0.0,
                    "PTS": 0.0,
                    "REB": 0.0,
                    "AST": 0.0,
                }
                by_key[key] = rec

            def _num(val):
                try:
                    n = float(val)
                except (TypeError, ValueError):
                    return 0.0
                if math.isnan(n):
                    return 0.0
                return n

            rec["GP"] += 1
            rec["MIN"] += _num(g.get("MIN"))
            rec["PTS"] += _num(g.get("PTS"))
            rec["REB"] += _num(
                g.get("REB") or g.get("TREB") or g.get("REB_TOTAL") or 0
            )
            rec["AST"] += _num(g.get("AST"))

        season_stats = []
        for rec in by_key.values():
            gp = rec["GP"] or 1
            season_stats.append(
                {
                    "PLAYER_ID": rec["PLAYER_ID"],
                    "PLAYER_NAME": rec["PLAYER_NAME"],
                    "TEAM_ABBREVIATION": rec["TEAM_ABBREVIATION"],
                    "GP": rec["GP"],
                    "MIN": round(rec["MIN"] / gp, 1),
                    "PTS": round(rec["PTS"] / gp, 1),
                    "REB": round(rec["REB"] / gp, 1),
                    "AST": round(rec["AST"] / gp, 1),
                }
            )

        block["season_stats"] = season_stats

    # Attach to bundle in the expected shape
    bundle.setdefault("nba", {})
    bundle["nba"]["seasons"] = seasons

    # Keep meta.current_season in sync: use existing if valid; else latest season key
    meta = bundle.setdefault("meta", {})
    current = meta.get("current_season") or meta.get("season")
    if current not in seasons and seasons:
        keys = sorted(seasons.keys())
        current = keys[-1]
    if current:
        meta["current_season"] = current


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
    else:
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
            # Raw Sleeper pieces
            league = fetch_sleeper_league()
            users = fetch_sleeper_users()
            rosters = fetch_sleeper_rosters()
            transactions = fetch_sleeper_transactions()
            players_raw = fetch_sleeper_players()

            # Convert big players dict -> list, and attach sleeper_player_id
            players_list = []
            for pid, pdata in players_raw.items():
                if not isinstance(pdata, dict):
                    continue
                pdata = dict(pdata)
                pdata["sleeper_player_id"] = pid
                players_list.append(pdata)

            # Build normalized roster-player rows with owner display name
            user_by_id = {}
            for u in users:
                uid = str(u.get("user_id"))
                if not uid:
                    continue
                user_by_id[uid] = u

            rosters_players = []
            for r in rosters:
                owner_id = str(r.get("owner_id"))
                owner = user_by_id.get(owner_id, {})
                display_name = (
                    owner.get("display_name")
                    or owner.get("metadata", {}).get("team_name")
                    or ""
                )
                for pid in (r.get("players") or []):
                    rosters_players.append(
                        {
                            "roster_id": r.get("roster_id"),
                            "owner_id": owner_id,
                            "display_name": display_name,
                            "sleeper_player_id": pid,
                        }
                    )

            bundle["sleeper"] = {
                "league": league,
                "users": users,
                "rosters": rosters,
                "transactions": transactions,
                "players": players_list,
                "rosters_players": rosters_players,
            }
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

    # === 4. Build nba.seasons + meta.generated_at_utc ===
    _build_nba_seasons_from_games(bundle)

    meta = bundle.setdefault("meta", {})
    # Update generated_at_utc to now (UTC) so frontend shows fresh date
    meta["generated_at_utc"] = datetime.utcnow().isoformat()

    # === 5. Save ===
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

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
