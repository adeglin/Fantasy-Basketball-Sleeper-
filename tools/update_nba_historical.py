import os
import sys
from datetime import date

# Ensure repo root is on path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from tools.update_engine import run_update


def main():
    # Production: full bundle path, no test mode, no max_days_back limit
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    output_path = os.path.join(repo_root, "docs", "data", "nba_historical.json")

    # If you want, hardcode your Sleeper league ID here:
    SLEEPER_LEAGUE_ID = "1202885172400234496"

    run_update(
        output_path=output_path,
        test_mode=False,
        max_days_back=None,            # full historical increment
        sleeper_league_id=SLEEPER_LEAGUE_ID,
    )


if __name__ == "__main__":
    main()
