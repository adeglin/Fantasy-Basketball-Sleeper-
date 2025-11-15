import json
from datetime import date, timedelta
from fetch_data import (
    fetch_nba_stats_by_date,
    fetch_sleeper_league_metadata,
    get_sleeper_players_map
)

# Path to the JSON file storing historical NBA stats
DATA_PATH = "data/nba_historical.json"  # adjust path if needed

# Optional: your Sleeper league ID to filter stats to only players in your league.
# If you don't want to filter by league, set LEAGUE_ID to None.
LEAGUE_ID = None  # e.g., LEAGUE_ID = "1234567890"

# Load existing data if file exists, otherwise start with empty dict
try:
    with open(DATA_PATH, 'r') as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}

# Determine the date range to update
if data:
    # Start from the day after the last date in our data
    last_date_str = max(data.keys())  # last recorded date (YYYY-MM-DD)
    last_date = date.fromisoformat(last_date_str)
    start_date = last_date + timedelta(days=1)
else:
    # If no data yet, start from the beginning of the current season (approx. Oct 1 of current or previous year)
    today = date.today()
    if today.month >= 10:
        season_start_year = today.year
    else:
        season_start_year = today.year - 1
    start_date = date(season_start_year, 10, 1)

end_date = date.today() - timedelta(days=1)  # up to yesterday

new_data_added = False

d = start_date
while d <= end_date:
    date_str = d.isoformat()
    # Fetch all NBA player stats for this date
    stats_list = fetch_nba_stats_by_date(date_str)
    # If a Sleeper league ID is provided, filter stats to only include players from that league
    if LEAGUE_ID and stats_list:
        try:
            league_meta = fetch_sleeper_league_metadata(LEAGUE_ID)
        except Exception as e:
            print(f"Error fetching Sleeper league data: {e}")
            league_meta = None
        if league_meta:
            # Get mapping of Sleeper player IDs to player info (to retrieve names)
            try:
                sleeper_players = get_sleeper_players_map("nba")
            except Exception as e:
                print(f"Error fetching Sleeper players data: {e}")
                sleeper_players = {}
            if sleeper_players:
                # Build a set of full names of players in the Sleeper league
                league_player_names = set()
                for team in league_meta["teams"]:
                    for player_id in team.get("players", []):
                        if player_id in sleeper_players:
                            first = sleeper_players[player_id].get("first_name", "")
                            last = sleeper_players[player_id].get("last_name", "")
                            full_name = f"{first} {last}".strip()
                            if full_name:
                                league_player_names.add(full_name)
                # Filter the stats list to only include players whose full name is in our league
                stats_list = [
                    s for s in stats_list 
                    if f"{s['player']['first_name']} {s['player']['last_name']}" in league_player_names
                ]
    # If we have stats for this date (after optional filtering), add to our data
    if stats_list:
        data[date_str] = stats_list
        new_data_added = True
        print(f"Fetched {len(stats_list)} player stats for {date_str}")
    else:
        print(f"No game stats for {date_str}")
    d += timedelta(days=1)

# Save updated data back to the JSON file if new data was added
if new_data_added:
    with open(DATA_PATH, 'w') as f:
        json.dump(data, f, indent=2)
    print("NBA historical data updated.")
else:
    print("No new data to update.")
