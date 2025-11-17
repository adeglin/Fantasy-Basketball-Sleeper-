import os
import sys
from datetime import date

# Make sure repo root is on import path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from tools.update_engine import run_update


def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    output_path = os.path.join(repo_root, "docs", "data", "nba_historical_test.json")

    # For local testing, we limit how far back we go (e.g., 3 days)
    MAX_DAYS_BACK = 3

    # You can comment this out if you don’t care about Sleeper for local testing
    SLEEPER_LEAGUE_ID = "1202885172400234496"

    print("[LOCAL TEST] Running update in TEST MODE")
    run_update(
        output_path=output_path,
        test_mode=True,
        max_days_back=MAX_DAYS_BACK,
        sleeper_league_id=SLEEPER_LEAGUE_ID,
    )
    print("[LOCAL TEST] Done. Check nba_historical_test.json")


if __name__ == "__main__":
    main()
