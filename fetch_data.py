import requests

# Hardcoded API key for BallDontLie (NBA data)
BALLDONTLIE_API_KEY = "dff1b999-16ba-417a-93ac-c2cdf81de883"
BALLDONTLIE_BASE_URL = "https://api.balldontlie.io/v1"
# Base URL for Sleeper API (no auth token needed for Sleeper)
SLEEPER_BASE_URL = "https://api.sleeper.app/v1"

def fetch_nba_stats_by_date(date_str, player_ids=None):
    """
    Fetch all NBA player stats for a given date (YYYY-MM-DD) using the BallDontLie API.
    Optionally filter by a list of BallDontLie player IDs.
    Returns a list of stat objects (each includes player, team, game info, and stats).
    """
    url = f"{BALLDONTLIE_BASE_URL}/stats?per_page=100&dates[]={date_str}"
    if player_ids:
        for pid in player_ids:
            url += f"&player_ids[]={pid}"
    headers = {"Authorization": BALLDONTLIE_API_KEY}
    results = []
    cursor = None
    while True:
        url_with_cursor = url if cursor is None else f"{url}&cursor={cursor}"
        try:
            resp = requests.get(url_with_cursor, headers=headers)
        except requests.RequestException as e:
            # If a network error occurs, break out (could log or retry as needed)
            print(f"Network error fetching stats for {date_str}: {e}")
            break
        if resp.status_code != 200:
            # If API returns an error status, log and break
            print(f"Failed to fetch stats for {date_str}: {resp.status_code} {resp.text}")
            break
        data = resp.json()
        if "data" not in data:
            # Unexpected response structure
            print(f"Unexpected response for {date_str}: {data}")
            break
        stats_list = data["data"]
        if not stats_list:
            # No stats returned for this date (e.g., no games on this date)
            break
        results.extend(stats_list)
        # Pagination: check if there's more data
        meta = data.get("meta", {})
        next_cursor = meta.get("next_cursor")
        if next_cursor:
            cursor = next_cursor  # fetch next page of results
            continue
        else:
            break
    return results

def get_sleeper_players_map(sport="nba"):
    """
    Fetches the Sleeper API players database for the given sport (default NBA).
    Returns a dictionary mapping Sleeper player IDs to their player information.
    This is a large call (~5MB data for NBA) and should be done at most once per day.
    """
    url = f"{SLEEPER_BASE_URL}/players/{sport}"
    resp = requests.get(url)
    if resp.status_code != 200:
        raise Exception(f"Failed to fetch Sleeper players data (status {resp.status_code})")
    return resp.json()

def fetch_sleeper_league_metadata(league_id):
    """
    Fetches metadata for a given Sleeper fantasy league, including league settings and rosters.
    Returns a dictionary with league info and a list of teams (each team includes roster and owner info).
    """
    # Get basic league information
    league_url = f"{SLEEPER_BASE_URL}/league/{league_id}"
    resp_league = requests.get(league_url)
    if resp_league.status_code != 200:
        raise Exception(f"Error fetching league {league_id}: HTTP {resp_league.status_code}")
    league_info = resp_league.json()

    # Get all rosters in the league
    rosters_url = f"{SLEEPER_BASE_URL}/league/{league_id}/rosters"
    resp_rosters = requests.get(rosters_url)
    if resp_rosters.status_code != 200:
        raise Exception(f"Error fetching rosters for league {league_id}: HTTP {resp_rosters.status_code}")
    rosters = resp_rosters.json()

    # Get all users in the league (to map owners to team names)
    users_url = f"{SLEEPER_BASE_URL}/league/{league_id}/users"
    resp_users = requests.get(users_url)
    if resp_users.status_code != 200:
        raise Exception(f"Error fetching users for league {league_id}: HTTP {resp_users.status_code}")
    users = resp_users.json()
    # Create a map for quick lookup of user info by user_id
    user_map = {user["user_id"]: user for user in users}

    # Build the list of teams with their rosters and owner info
    teams = []
    for roster in rosters:
        owner_id = roster.get("owner_id")
        user_info = user_map.get(owner_id, {})
        # Determine team name: use user-provided team name if available, otherwise fall back to display name or roster ID
        if "metadata" in user_info and user_info["metadata"].get("team_name"):
            team_name = user_info["metadata"]["team_name"]
        else:
            team_name = user_info.get("display_name") or user_info.get("username") or f"Team {roster.get('roster_id')}"
        team_data = {
            "roster_id": roster.get("roster_id"),
            "owner_id": owner_id,
            "team_name": team_name,
            "players": roster.get("players", []),    # list of Sleeper player IDs on this roster
            "starters": roster.get("starters", []),  # list of starting player IDs for current matchup (if in season)
            # include optional standings info if available
            "wins": roster.get("settings", {}).get("wins"),
            "losses": roster.get("settings", {}).get("losses"),
            "ties": roster.get("settings", {}).get("ties"),
            "points_for": roster.get("settings", {}).get("fpts"),
            "points_against": roster.get("settings", {}).get("fpts_against")
        }
        teams.append(team_data)

    # Compile league metadata
    league_metadata = {
        "league_id": league_id,
        "league_name": league_info.get("name"),
        "season": league_info.get("season"),
        "status": league_info.get("status"),
        "total_rosters": league_info.get("total_rosters"),
        "teams": teams
    }
    return league_metadata
