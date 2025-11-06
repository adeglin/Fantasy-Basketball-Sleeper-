async function loadDataBundle() {
  const res = await fetch("./data/data_bundle.json", { cache: "no-cache" });
  if (!res.ok) {
    throw new Error("Failed to load data_bundle.json");
  }
  return res.json();
}

// Simple helper to escape HTML
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMeta(meta) {
  const el = document.getElementById("meta");
  el.textContent = `Last updated (UTC): ${meta.generated_at_utc} | Current season: ${meta.current_season}`;
}

function renderPlayersTable(bundle) {
  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];
  if (!seasonBlock) {
    document.getElementById("players-table").textContent = "No season data available.";
    return;
  }

  const stats = seasonBlock.season_stats || [];
  const rostersPlayers = bundle.sleeper?.rosters_players || [];

  // Build a quick map of sleeper_player_id -> owner_name
  const ownershipMap = {};
  for (const row of rostersPlayers) {
    const pid = row.sleeper_player_id;
    const owner = row.display_name || "Unknown";
    if (pid) {
      ownershipMap[pid] = owner;
    }
  }

  // For now, just show top 100 players by PTS
  const sorted = [...stats].sort((a, b) => (b.PTS ?? 0) - (a.PTS ?? 0)).slice(0, 100);

  let html = "<table><thead><tr>";
  html += "<th>Player</th><th>Team</th><th>GP</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>Owner</th>";
  html += "</tr></thead><tbody>";

  for (const row of sorted) {
    const sleeperId = row.sleeper_player_id || null; // not yet populated in bundle (we'll use later)
    const ownerName = ownershipMap[sleeperId] || null;

    const ownerCell = ownerName
      ? `<span class="pill pill-rostered">${esc(ownerName)}</span>`
      : `<span class="pill pill-fa">FA</span>`;

    html += "<tr>";
    html += `<td>${esc(row.PLAYER_NAME)}</td>`;
    html += `<td>${esc(row.TEAM_ABBREVIATION)}</td>`;
    html += `<td>${esc(row.GP)}</td>`;
    html += `<td>${esc(row.MIN)}</td>`;
    html += `<td>${esc(row.PTS)}</td>`;
    html += `<td>${esc(row.REB)}</td>`;
    html += `<td>${esc(row.AST)}</td>`;
    html += `<td>${ownerCell}</td>`;
    html += "</tr>";
  }

  html += "</tbody></table>";
  document.getElementById("players-table").innerHTML = html;
}

function renderRostersTable(bundle) {
  const rosters = bundle.sleeper?.rosters || [];
  const users = bundle.sleeper?.users || [];

  if (!rosters.length) {
    document.getElementById("rosters-table").textContent = "No roster data available.";
    return;
  }

  const userMap = {};
  for (const u of users) {
    userMap[u.user_id] = u.display_name;
  }

  let html = "<table><thead><tr>";
  html += "<th>Roster ID</th><th>Owner</th><th># Players</th><th># Starters</th><th># Reserve</th>";
  html += "</tr></thead><tbody>";

  for (const r of rosters) {
    const ownerName = r.display_name || userMap[r.owner_id] || "Unknown";
    const numPlayers = (r.players || []).length;
    const numStarters = (r.starters || []).length;
    const numReserve = (r.reserve || []).length;

    html += "<tr>";
    html += `<td>${esc(r.roster_id)}</td>`;
    html += `<td>${esc(ownerName)}</td>`;
    html += `<td>${numPlayers}</td>`;
    html += `<td>${numStarters}</td>`;
    html += `<td>${numReserve}</td>`;
    html += "</tr>";
  }

  html += "</tbody></table>";
  document.getElementById("rosters-table").innerHTML = html;
}

async function fetchLiveInjuries() {
  const container = document.getElementById("injuries-table");
  container.textContent = "Loading live injuries...";

  try {
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries", {
      cache: "no-cache",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    const injuries = [];
    for (const team of data.injuries || []) {
      const teamAbbr = team.team?.abbreviation || "N/A";
      for (const injury of team.injuries || []) {
        const details = injury.details || {};
        injuries.push({
          player: injury.athlete?.displayName || "N/A",
          team: teamAbbr,
          status: injury.status || "N/A",
          type: injury.type || "N/A",
          detail: details.detail || "",
          returnDate: details.returnDate || "",
        });
      }
    }

    if (!injuries.length) {
      container.textContent = "No injuries reported.";
      return;
    }

    let html = "<table><thead><tr>";
    html += "<th>Player</th><th>Team</th><th>Status</th><th>Injury</th><th>Detail</th><th>Return</th>";
    html += "</tr></thead><tbody>";

    for (const inj of injuries) {
      const statusPill = `<span class="pill pill-inj">${esc(inj.status)}</span>`;
      html += "<tr>";
      html += `<td>${esc(inj.player)}</td>`;
      html += `<td>${esc(inj.team)}</td>`;
      html += `<td>${statusPill}</td>`;
      html += `<td>${esc(inj.type)}</td>`;
      html += `<td>${esc(inj.detail)}</td>`;
      html += `<td>${esc(inj.returnDate)}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;
  } catch (err) {
    console.error("Error fetching live injuries:", err);
    container.textContent =
      "Could not load live injuries. ESPN may be blocking cross-origin requests; you may need a backend proxy later.";
  }
}

async function init() {
  try {
    const bundle = await loadDataBundle();
    renderMeta(bundle.meta);
    renderPlayersTable(bundle);
    renderRostersTable(bundle);
  } catch (err) {
    console.error(err);
    document.getElementById("meta").textContent = "Error loading data bundle.";
  }

  // Live injuries are independent of the nightly bundle
  fetchLiveInjuries();
}

init();
