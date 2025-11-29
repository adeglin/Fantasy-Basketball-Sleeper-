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


# ---- Helpers for building nba.seasons ----

def _parse_minutes(val) -> float:
    """
    Convert either "MM:SS", "18.3", 18, or 0 to a float minutes value.
    """
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str):
        s = val.strip()
        if ":" in s:
            parts = s.split(":")
            try:
                m = int(parts[0] or 0)
                sec = int(parts[1] or 0)
                return m + sec / 60.0
            except ValueError:
                pass
        try:
            return float(s)
        except ValueError:
            return 0.0
    return 0.0


def _num(val) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def _build_nba_from_games(bundle: dict) -> None:
    """
    Take bundle["games"] (date -> list of game dicts with .players)
    and build:

      bundle["meta"]["generated_at_utc"]
      bundle["meta"]["current_season"]
      bundle["nba"]["seasons"][season_key].game_logs
      bundle["nba"]["seasons"][season_key].season_stats
    """
    games_by_date = bundle.get("games") or {}
    if not games_by_date:
        # Nothing to build
        return

    all_logs = []

    # Flatten games -> player game logs
    for date_str, games in sorted(games_by_date.items()):
        for game in games:
            players = game.get("players") or []
            game_meta = game.get("game") or {}
            matchup = game_meta.get("MATCHUP")

            for p in players:
                rec = dict(p)  # shallow copy

                # Ensure GAME_DATE is present
                rec.setdefault("GAME_DATE", date_str)

                # Ensure TEAM_ABBREVIATION exists in some form
                if "TEAM_ABBREVIATION" not in rec:
                    team_abbr = (
                        rec.get("TEAM_ABBREVIATION")
                        or rec.get("TEAM_ABBR")
                        or rec.get("TEAM_NAME")
                        or ""
                    )
                    rec["TEAM_ABBREVIATION"] = team_abbr

                # Carry MATCHUP if we have it
                if "MATCHUP" not in rec and matchup:
                    rec["MATCHUP"] = matchup

                all_logs.append(rec)

    if not all_logs:
        return

    # Determine season key
    meta = bundle.setdefault("meta", {})
    season_key = meta.get("current_season") or meta.get("season")

    if not season_key:
        # Derive from last_game_date
        last_str = bundle.get("last_game_date")
        if last_str:
            dt = datetime.strptime(last_str, "%Y-%m-%d").date()
            if dt.month >= 10:
                season_start_year = dt.year
                next_year = (dt.year + 1) % 100
            else:
                season_start_year = dt.year - 1
                next_year = dt.year % 100
            season_key = f"{season_start_year}-{next_year:02d}"
        else:
            season_key = "Unknown"

    meta["current_season"] = season_key

    # Compute season_stats: per-player per-team averages
    by_key = {}
    for g in all_logs:
        pid = g.get("PLAYER_ID") or g.get("player_id") or g.get("PLAYER_NAME") or ""
        team = g.get("TEAM_ABBREVIATION") or g.get("TEAM_ABBR") or ""
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

        rec["GP"] += 1
        rec["MIN"] += _parse_minutes(g.get("MIN"))
        # PTS
        rec["PTS"] += _num(g.get("PTS"))
        # REB (various spellings)
        reb = g.get("REB")
        if reb is None:
            for alt in ("TREB", "REB_TOTAL"):
                if g.get(alt) is not None:
                    reb = g.get(alt)
                    break
        rec["REB"] += _num(reb)
        # AST
        rec["AST"] += _num(g.get("AST"))

    season_stats = []
    for rec in by_key.values():
        gp = rec["GP"] or 1
        rec["MIN"] = round(rec["MIN"] / gp, 1)
        rec["PTS"] = round(rec["PTS"] / gp, 1)
        rec["REB"] = round(rec["REB"] / gp, 1)
        rec["AST"] = round(rec["AST"] / gp, 1)
        season_stats.append(rec)

    bundle["nba"] = {
        "seasons": {
            season_key: {
                "game_logs": all_logs,
                "season_stats": season_stats,
            }
        }
    }

    # Update last generated timestamp
    meta["generated_at_utc"] = datetime.utcnow().isoformat()


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

    # === 4. Build nba.seasons + meta from games ===
    _build_nba_from_games(bundle)

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
