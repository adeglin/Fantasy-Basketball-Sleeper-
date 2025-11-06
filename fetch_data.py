import time
import json
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests
import pandas as pd
from nba_api.stats.endpoints import (
    LeagueDashPlayerStats,
    PlayerGameLogs,
)

# -----------------------------
# CONFIG
# -----------------------------
LEAGUE_ID = "1202885172400234496"
CURRENT_SEASON = "2025-26"          # NBA.com format
HISTORICAL_SEASONS = ["2023-24", "2024-25"]  # seasons you want once-and-done
SEASON_TYPE = "Regular Season"

DOCS_DATA_DIR = Path("docs/data")
DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)

# Per-season cache files (so we only fetch historical once)
def season_stats_path(season: str) -> Path:
    return DOCS_DATA_DIR / f"nba_season_stats_{season}.json"

def season_gamelogs_path(season: str) -> Path:
    return DOCS_DATA_DIR / f"nba_game_logs_{season}.json"


def safe_get(url, desc, timeout=10):
    print(f"[HTTP] {desc} ... {url}")
    try:
        resp = requests.get(url, timeout=timeout)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"[WARN] Error fetching {desc}: {e}")
        return None


def norm_name(s):
    """Normalize a player name for matching / joins."""
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return " ".join(s.lower().strip().split())


# -----------------------------
# Sleeper players metadata
# -----------------------------
def fetch_sleeper_players():
    url = "https://api.sleeper.app/v1/players/nba"
    data = safe_get(url, "Sleeper NBA players", timeout=25)
    if not data:
        return []

    records = []
    for pid, p in data.items():
        records.append({
            "sleeper_player_id": pid,
            "full_name": p.get("full_name"),
            "first_name": p.get("first_name"),
            "last_name": p.get("last_name"),
            "position": p.get("position"),
            "team": p.get("team"),
            "fantasy_positions": p.get("fantasy_positions"),
            "status": p.get("status"),
            "injury_status": p.get("injury_status"),
            "injury_notes": p.get("injury_notes"),
            "age": p.get("age"),
            "years_exp": p.get("years_exp"),
            "active": p.get("active"),
        })
    print(f"[Sleeper] Players metadata rows: {len(records)}")
    return records


# -----------------------------
# Sleeper league / rosters / transactions
# -----------------------------
def fetch_sleeper_block():
    base_league_url = f"https://api.sleeper.app/v1/league/{LEAGUE_ID}"

    league = safe_get(base_league_url, "Sleeper league info")
    if not league:
        raise SystemExit("Could not load league info from Sleeper")

    users = safe_get(f"{base_league_url}/users", "Sleeper league users") or []
    rosters = safe_get(f"{base_league_url}/rosters", "Sleeper rosters") or []

    users_df = pd.DataFrame(users) if users else pd.DataFrame(columns=["user_id", "display_name"])
    rosters_df = pd.DataFrame(rosters) if rosters else pd.DataFrame()

    if not rosters_df.empty and not users_df.empty:
        rosters_df = rosters_df.merge(
            users_df[["user_id", "display_name"]],
            left_on="owner_id",
            right_on="user_id",
            how="left",
        )

    # Exploded rosters to player-level (each row = one player on one roster)
    rosters_exploded = pd.DataFrame()
    if not rosters_df.empty:
        rosters_exploded = rosters_df.explode("players", ignore_index=True)
        rosters_exploded = rosters_exploded.rename(columns={"players": "sleeper_player_id"})
        rosters_exploded["sleeper_player_id"] = rosters_exploded["sleeper_player_id"].astype(str)

    # Transactions by week (using league settings to know current week)
    settings = league.get("settings", {}) or {}
    max_week = settings.get("leg") or settings.get("last_scored_leg") or 1
    max_week = int(max_week)

    transactions_all = []
    for week in range(1, max_week + 1):
        tx = safe_get(f"{base_league_url}/transactions/{week}", f"Sleeper transactions week {week}")
        if tx and isinstance(tx, list):
            for t in tx:
                t["week"] = week
                transactions_all.append(t)
        time.sleep(0.1)

    transactions_df = pd.DataFrame(transactions_all) if transactions_all else pd.DataFrame()

    # Sleeper players metadata
    players_list = fetch_sleeper_players()

    sleeper_block = {
        "league": league,
        "users": users_df.to_dict(orient="records"),
        "rosters": rosters_df.to_dict(orient="records"),
        "rosters_players": rosters_exploded.to_dict(orient="records"),
        "transactions": transactions_df.to_dict(orient="records"),
        "players": players_list,
    }
    return sleeper_block


# -----------------------------
# NBA season stats + game logs
# -----------------------------
def fetch_or_load_nba_season_stats(season: str) -> pd.DataFrame:
    path = season_stats_path(season)
    if path.exists() and season in HISTORICAL_SEASONS:
        print(f"[CACHE] Loading NBA season stats from {path}")
        return pd.read_json(path)

    print(f"[NBA] Fetching season stats for {season} ...")
    stats = LeagueDashPlayerStats(
        season=season,
        season_type_all_star=SEASON_TYPE,
        per_mode_detailed="PerGame",
        timeout=60,
    )
    df = stats.get_data_frames()[0]
    df["MIN"] = pd.to_numeric(df["MIN"], errors="coerce").fillna(0)
    df = df[df["MIN"] > 0].copy()

    if season in HISTORICAL_SEASONS:
        df.to_json(path, orient="records")
        print(f"[CACHE] Saved NBA season stats {season} -> {path}")

    return df


def fetch_or_load_nba_gamelogs(season: str) -> pd.DataFrame:
    path = season_gamelogs_path(season)
    if path.exists() and season in HISTORICAL_SEASONS:
        print(f"[CACHE] Loading NBA game logs from {path}")
        return pd.read_json(path)

    print(f"[NBA] Fetching game logs for {season} ...")
    logs = PlayerGameLogs(
        season_nullable=season,
        season_type_nullable=SEASON_TYPE,
        timeout=60,
    )
    df = logs.get_data_frames()[0]

    if season in HISTORICAL_SEASONS:
        df.to_json(path, orient="records")
        print(f"[CACHE] Saved NBA game logs {season} -> {path}")

    return df


def fetch_nba_schedule():
    print("[NBA] Fetching league schedule JSON ...")
    schedule_url = "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json"
    schedule_json = safe_get(schedule_url, "NBA league schedule", timeout=20)

    if not schedule_json or "leagueSchedule" not in schedule_json:
        print("[WARN] Could not load NBA schedule.")
        return []

    days = schedule_json["leagueSchedule"]["gameDates"]
    games = []
    for day in days:
        for g in day.get("games", []):
            games.append(g)

    schedule_raw = pd.json_normalize(games, sep="_")
    schedule_keep_cols = [
        "gameId",
        "gameCode",
        "gameDate",
        "gameDateTimeUTC",
        "gameStatus",
        "gameStatusText",
        "homeTeam_teamId",
        "homeTeam_teamTricode",
        "homeTeam_teamName",
        "homeTeam_score",
        "awayTeam_teamId",
        "awayTeam_teamTricode",
        "awayTeam_teamName",
        "awayTeam_score",
    ]
    for col in schedule_keep_cols:
        if col not in schedule_raw.columns:
            schedule_raw[col] = pd.NA

    schedule_df = schedule_raw[schedule_keep_cols].sort_values("gameDate")
    return schedule_df.to_dict(orient="records")


# -----------------------------
# MAIN: build data bundle
# -----------------------------
def main():
    print("=== Building data bundle ===")

    # 1) Sleeper
    sleeper_block = fetch_sleeper_block()

    # 2) NBA seasons (historical + current)
    nba_seasons = {}
    for season in HISTORICAL_SEASONS + [CURRENT_SEASON]:
        try:
            season_stats_df = fetch_or_load_nba_season_stats(season)
            season_logs_df = fetch_or_load_nba_gamelogs(season)
        except Exception as e:
            print(f"[WARN] Skipping NBA season {season} due to error: {e}")
            continue

        nba_seasons[season] = {
            "season_stats": season_stats_df.to_dict(orient="records"),
            "game_logs": season_logs_df.to_dict(orient="records"),
        }

    # 3) NBA schedule
    schedule = fetch_nba_schedule()

    # 4) Build final bundle
    bundle = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "current_season": CURRENT_SEASON,
            "historical_seasons": HISTORICAL_SEASONS,
        },
        "sleeper": sleeper_block,
        "nba": {
            "seasons": nba_seasons,
            "schedule": schedule,
        },
    }

    out_path = DOCS_DATA_DIR / "data_bundle.json"
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, separators=(",", ":"))

    print(f"[OK] Wrote data bundle -> {out_path.resolve()}")


if __name__ == "__main__":
    main()
