import json
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
from nba_api.stats.endpoints import PlayerGameLogs

# Where we will store the historical NBA data
HIST_PATH = Path("docs/data/nba_historical.json")

# Configure which season to pull
CURRENT_SEASON = "2025-26"
SEASON_TYPE = "Regular Season"


def parse_minutes_to_float(min_str: str) -> float:
    """
    Convert NBA 'MIN' strings to float minutes.
    Examples: '35:21' -> 35.35, '23' -> 23.0, ''/None -> 0.0
    """
    if not isinstance(min_str, str) or not min_str.strip():
        return 0.0

    if ":" in min_str:
        mins, secs = min_str.split(":", 1)
        try:
            mins_i = int(mins)
            secs_i = int(secs)
            return mins_i + secs_i / 60.0
        except ValueError:
            return 0.0
    else:
        try:
            return float(min_str)
        except ValueError:
            return 0.0


def df_to_records(df: pd.DataFrame):
    if df is None or df.empty:
        return []
    # Ensure datetimes are JSON-serializable
    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.strftime("%Y-%m-%dT%H:%M:%S")
    return df.to_dict(orient="records")


def main():
    print(f"[INFO] Fetching full NBA game logs for {CURRENT_SEASON} ({SEASON_TYPE})")

    # Pull all game logs for the season
    logs_endpoint = PlayerGameLogs(
        season_nullable=CURRENT_SEASON,
        season_type_nullable=SEASON_TYPE,
        timeout=60,
    )
    logs_df = logs_endpoint.get_data_frames()[0]
    print(f"[INFO] Retrieved {len(logs_df)} game log rows")

    if logs_df.empty:
        raise SystemExit("[ERROR] No logs returned from NBA API; aborting.")

    # Normalize minutes
    if "MIN" in logs_df.columns:
        logs_df["MIN"] = logs_df["MIN"].apply(parse_minutes_to_float)

    # Make sure numeric columns are numeric
    numeric_cols = ["MIN", "PTS", "REB", "AST", "STL", "BLK", "TOV"]
    for col in numeric_cols:
        if col in logs_df.columns:
            logs_df[col] = pd.to_numeric(logs_df[col], errors="coerce").fillna(0)

    # Add season year column for clarity
    logs_df["SEASON_YEAR"] = CURRENT_SEASON

    # Build per-player season averages
    group_cols = ["PLAYER_ID", "PLAYER_NAME", "TEAM_ABBREVIATION"]
    stats_agg = logs_df.groupby(group_cols).agg(
        GP=("GAME_ID", "nunique"),
        MIN=("MIN", "mean"),
        PTS=("PTS", "mean"),
        REB=("REB", "mean"),
        AST=("AST", "mean"),
        STL=("STL", "mean"),
        BLK=("BLK", "mean"),
        TOV=("TOV", "mean"),
    ).reset_index()

    # Round for readability
    for col in ["MIN", "PTS", "REB", "AST", "STL", "BLK", "TOV"]:
        if col in stats_agg.columns:
            stats_agg[col] = stats_agg[col].round(1)

    # Prepare JSON structure
    data = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "season": CURRENT_SEASON,
            "season_type": SEASON_TYPE,
        },
        "player_gamelogs": df_to_records(logs_df),
        "players_stats": df_to_records(stats_agg),
    }

    # Ensure output folder exists
    HIST_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Write JSON
    with HIST_PATH.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

    print(f"[OK] Wrote NBA historical data to {HIST_PATH.resolve()}")


if __name__ == "__main__":
    main()
