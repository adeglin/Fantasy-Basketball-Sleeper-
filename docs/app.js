// ============ BASIC HELPERS ============

async function loadDataBundle() {
  const res = await fetch("./data/data_bundle.json", { cache: "no-cache" });
  if (!res.ok) {
    throw new Error("Failed to load data_bundle.json");
  }
  return res.json();
}

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// simple name normalizer for joins (strip accents, lowercase, collapse spaces)
function normName(s) {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function setupTabs() {
  const buttons = document.querySelectorAll(".tab-button");
  const contents = document.querySelectorAll(".tab-content");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      buttons.forEach((b) => b.classList.remove("active"));
      contents.forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${tab}`).classList.add("active");
    });
  });
}

// ============ META / OVERVIEW ============

function renderMeta(meta, leagueName) {
  const el = document.getElementById("meta");
  const namePart = leagueName ? ` | League: ${leagueName}` : "";
  el.textContent = `Last updated (UTC): ${meta.generated_at_utc} | Current season: ${meta.current_season}${namePart}`;
}

function renderOverviewPlayers(bundle) {
  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];
  const container = document.getElementById("overview-players-table");

  if (!seasonBlock || !seasonBlock.season_stats || !seasonBlock.season_stats.length) {
    container.textContent = "No current season data available.";
    console.warn("No season_stats found for", currentSeason, bundle.nba?.seasons);
    return;
  }

  const stats = seasonBlock.season_stats;
  const sorted = [...stats].sort((a, b) => (b.PTS ?? 0) - (a.PTS ?? 0)).slice(0, 150);

  let html = "<table><thead><tr>";
  html += "<th>Player</th><th>Team</th><th>GP</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th>";
  html += "</tr></thead><tbody>";

  for (const row of sorted) {
    html += "<tr>";
    html += `<td>${esc(row.PLAYER_NAME)}</td>`;
    html += `<td>${esc(row.TEAM_ABBREVIATION)}</td>`;
    html += `<td>${esc(row.GP)}</td>`;
    html += `<td>${esc(row.MIN)}</td>`;
    html += `<td>${esc(row.PTS)}</td>`;
    html += `<td>${esc(row.REB)}</td>`;
    html += `<td>${esc(row.AST)}</td>`;
    html += "</tr>";
  }

  html += "</tbody></table>";
  container.innerHTML = html;
}

// ============ ROSTERS (FULL PER OWNER) ============

function renderRostersTable(bundle) {
  const container = document.getElementById("rosters-table");
  const rostersPlayers = bundle.sleeper?.rosters_players || [];
  const players = bundle.sleeper?.players || [];
  const ownerFilterInput = document.getElementById("rosters-owner-filter");
  const playerFilterInput = document.getElementById("rosters-player-filter");

  if (!rostersPlayers.length) {
    container.textContent = "No roster-player data available.";
    return;
  }

  const playerMap = new Map();
  for (const p of players) {
    if (!p.sleeper_player_id) continue;
    playerMap.set(String(p.sleeper_player_id), p);
  }

  function doRender() {
    const ownerFilter = (ownerFilterInput.value || "").toLowerCase();
    const playerFilter = (playerFilterInput.value || "").toLowerCase();

    let rows = rostersPlayers;

    if (ownerFilter) {
      rows = rows.filter((r) =>
        (r.display_name || "").toLowerCase().includes(ownerFilter)
      );
    }

    if (playerFilter) {
      rows = rows.filter((r) => {
        const p = playerMap.get(String(r.sleeper_player_id)) || {};
        const fullName = (p.full_name || "").toLowerCase();
        return fullName.includes(playerFilter);
      });
    }

    rows = [...rows].sort((a, b) => {
      const ao = (a.display_name || "").localeCompare(b.display_name || "");
      if (ao !== 0) return ao;
      return (a.roster_id || 0) - (b.roster_id || 0);
    });

    let html = "<table><thead><tr>";
    html += "<th>Owner</th><th>Roster</th><th>Player</th><th>Team</th><th>Pos</th><th>Fantasy Pos</th><th>Injury</th>";
    html += "</tr></thead><tbody>";

    for (const r of rows) {
      const pid = String(r.sleeper_player_id);
      const p = playerMap.get(pid) || {};
      const pos = p.position || "";
      const fpos = (p.fantasy_positions || []).join(", ");
      const inj = p.injury_status ? `${p.injury_status}` : "";
      const injNotes = p.injury_notes ? ` — ${p.injury_notes}` : "";
      const injDisplay = inj ? `${inj}${injNotes}` : "";

      html += "<tr>";
      html += `<td><span class="pill pill-owner">${esc(r.display_name || "Unknown")}</span></td>`;
      html += `<td>${esc(r.roster_id)}</td>`;
      html += `<td>${esc(p.full_name || pid)}</td>`;
      html += `<td>${esc(p.team || "")}</td>`;
      html += `<td>${pos ? `<span class="pill pill-pos">${esc(pos)}</span>` : ""}</td>`;
      html += `<td>${esc(fpos)}</td>`;
      html += `<td>${esc(injDisplay)}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;
  }

  ownerFilterInput.addEventListener("input", doRender);
  playerFilterInput.addEventListener("input", doRender);

  doRender();
}

// ============ FREE AGENTS (ACTIVE 2025–26 PLAYERS, NOT ROSTERED) ============

function renderFreeAgentsTable(bundle) {
  const container = document.getElementById("fa-table");
  const rostersPlayers = bundle.sleeper?.rosters_players || [];
  const players = bundle.sleeper?.players || [];

  if (!players.length) {
    container.textContent = "No Sleeper players metadata available.";
    return;
  }

  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];
  if (!seasonBlock || !seasonBlock.season_stats || !seasonBlock.season_stats.length) {
    container.textContent = "No current season NBA stats available; cannot compute free agents.";
    return;
  }

  const stats = seasonBlock.season_stats;
  const statsNameSet = new Set(stats.map((s) => normName(s.PLAYER_NAME)));

  // All sleeper IDs currently on a roster
  const owned = new Set();
  for (const r of rostersPlayers) {
    if (r.sleeper_player_id != null) {
      owned.add(String(r.sleeper_player_id));
    }
  }

  // Active 2025–26 NBA players in Sleeper pool who are NOT on a fantasy roster
  const candidateFA = players.filter((p) => {
    const id = String(p.sleeper_player_id || "");
    if (!id || owned.has(id)) return false;

    // must be an NBA player this season
    if (!p.team) return false; // no team => ignore
    if (p.active === false) return false;

    const nm = normName(p.full_name);
    if (!statsNameSet.has(nm)) return false; // not in 2025–26 stats => ignore

    return true;
  });

  const filterInput = document.getElementById("fa-player-filter");
  const posSelect = document.getElementById("fa-pos-filter");

  function doRender() {
    const nameFilter = (filterInput.value || "").toLowerCase();
    const posFilter = posSelect.value || "";

    let rows = candidateFA;

    if (nameFilter) {
      rows = rows.filter((p) =>
        (p.full_name || "").toLowerCase().includes(nameFilter)
      );
    }

    if (posFilter) {
      rows = rows.filter((p) => {
        const pos = p.position || "";
        const fpos = (p.fantasy_positions || []).join(",");
        return pos.includes(posFilter) || fpos.includes(posFilter);
      });
    }

    rows = [...rows].sort((a, b) =>
      (a.full_name || "").localeCompare(b.full_name || "")
    );

    let html = "<table><thead><tr>";
    html += "<th>Player</th><th>Team</th><th>Pos</th><th>Fantasy Pos</th><th>Status</th><th>Injury</th>";
    html += "</tr></thead><tbody>";

    for (const p of rows) {
      const pos = p.position || "";
      const fpos = (p.fantasy_positions || []).join(", ");
      const status = p.status || "";
      const inj = p.injury_status || "";
      const injNotes = p.injury_notes || "";

      html += "<tr>";
      html += `<td>${esc(p.full_name || p.sleeper_player_id)}</td>`;
      html += `<td>${esc(p.team || "")}</td>`;
      html += `<td>${pos ? `<span class="pill pill-pos">${esc(pos)}</spa
