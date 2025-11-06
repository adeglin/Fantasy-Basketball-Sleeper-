// --------- helpers ---------
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

// --------- META / OVERVIEW ---------
function renderMeta(meta, leagueName) {
  const el = document.getElementById("meta");
  const namePart = leagueName ? ` | League: ${leagueName}` : "";
  el.textContent = `Last updated (UTC): ${meta.generated_at_utc} | Current season: ${meta.current_season}${namePart}`;
}

function renderOverviewPlayers(bundle) {
  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];
  const container = document.getElementById("overview-players-table");

  if (!seasonBlock) {
    container.textContent = "No current season data available.";
    return;
  }

  const stats = seasonBlock.season_stats || [];
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

// --------- ROSTERS ---------
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

    // Sort by owner, then roster_id
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

// --------- FREE AGENTS ---------
function renderFreeAgentsTable(bundle) {
  const container = document.getElementById("fa-table");
  const rostersPlayers = bundle.sleeper?.rosters_players || [];
  const players = bundle.sleeper?.players || [];
  const filterInput = document.getElementById("fa-player-filter");
  const posSelect = document.getElementById("fa-pos-filter");

  if (!players.length) {
    container.textContent = "No Sleeper players metadata available.";
    return;
  }

  const owned = new Set();
  for (const r of rostersPlayers) {
    if (r.sleeper_player_id != null) {
      owned.add(String(r.sleeper_player_id));
    }
  }

  const allFA = players.filter((p) => {
    const id = String(p.sleeper_player_id || "");
    if (!id || owned.has(id)) return false;
    // skip clearly inactive/no position guys
    if (!p.position && !(p.fantasy_positions && p.fantasy_positions.length)) return false;
    return true;
  });

  function doRender() {
    const nameFilter = (filterInput.value || "").toLowerCase();
    const posFilter = posSelect.value || "";

    let rows = allFA;

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
      html += `<td>${pos ? `<span class="pill pill-pos">${esc(pos)}</span>` : ""}</td>`;
      html += `<td>${esc(fpos)}</td>`;
      html += `<td>${esc(status)}</td>`;
      html += `<td>${esc(inj + (injNotes ? " — " + injNotes : ""))}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;
  }

  filterInput.addEventListener("input", doRender);
  posSelect.addEventListener("change", doRender);

  doRender();
}

// --------- GAME LOGS ---------
function setupGameLogs(bundle) {
  const seasonSelect = document.getElementById("gamelogs-season-select");
  const playerFilterInput = document.getElementById("gamelogs-player-filter");
  const container = document.getElementById("gamelogs-table");

  const seasons = Object.keys(bundle.nba?.seasons || {});
  if (!seasons.length) {
    container.textContent = "No game logs available.";
    return;
  }

  // Populate season dropdown
  seasons.sort();
  for (const s of seasons) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    if (s === bundle.meta.current_season) opt.selected = true;
    seasonSelect.appendChild(opt);
  }

  function doRender() {
    const season = seasonSelect.value;
    const playerFilter = (playerFilterInput.value || "").toLowerCase();
    const seasonBlock = bundle.nba.seasons[season];
    if (!seasonBlock) {
      container.textContent = "No logs for selected season.";
      return;
    }

    const logs = seasonBlock.game_logs || [];
    if (!logs.length) {
      container.textContent = "No logs for selected season.";
      return;
    }

    // Sort by game date descending
    const logsCopy = [...logs].sort((a, b) => {
      const da = new Date(a.GAME_DATE);
      const db = new Date(b.GAME_DATE);
      return db - da;
    });

    // Filter by player
    const filtered = logsCopy.filter((g) =>
      (g.PLAYER_NAME || "").toLowerCase().includes(playerFilter)
    );

    // Limit rows (for speed in browser)
    const rows = filtered.slice(0, 400);

    // Determine "recent" threshold: last 3 days from most recent game in this season
    let recentThreshold = null;
    if (logsCopy.length) {
      const mostRecentDate = new Date(logsCopy[0].GAME_DATE);
      recentThreshold = new Date(mostRecentDate.getTime() - 3 * 24 * 60 * 60 * 1000);
    }

    let html = "<table><thead><tr>";
    html += "<th>Date</th><th>Player</th><th>Team</th><th>Matchup</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th>";
    html += "</tr></thead><tbody>";

    for (const g of rows) {
      const d = new Date(g.GAME_DATE);
      const recent = recentThreshold && d >= recentThreshold;

      html += `<tr${recent ? ' class="highlight-recent"' : ""}>`;
      html += `<td>${esc(g.GAME_DATE)}</td>`;
      html += `<td>${esc(g.PLAYER_NAME)}</td>`;
      html += `<td>${esc(g.TEAM_ABBREVIATION)}</td>`;
      html += `<td>${esc(g.MATCHUP || "")}</td>`;
      html += `<td>${esc(g.MIN)}</td>`;
      html += `<td>${esc(g.PTS)}</td>`;
      html += `<td>${esc(g.REB)}</td>`;
      html += `<td>${esc(g.AST)}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;
  }

  seasonSelect.addEventListener("change", doRender);
  playerFilterInput.addEventListener("input", doRender);

  doRender();
}

// --------- TRANSACTIONS ---------
function renderTransactions(bundle) {
  const container = document.getElementById("transactions-table");
  const txs = bundle.sleeper?.transactions || [];
  const players = bundle.sleeper?.players || [];

  if (!txs.length) {
    container.textContent = "No transactions found.";
    return;
  }

  const playerMap = new Map();
  for (const p of players) {
    if (!p.sleeper_player_id) continue;
    playerMap.set(String(p.sleeper_player_id), p.full_name || p.sleeper_player_id);
  }

  function formatAddsDrops(obj) {
    if (!obj) return "";
    const names = [];
    for (const pid of Object.keys(obj)) {
      const name = playerMap.get(String(pid)) || pid;
      names.push(name);
    }
    return names.join(", ");
  }

  // Sort by week descending, then maybe by created time if present
  const rows = [...txs].sort((a, b) => {
    const aw = a.week || 0;
    const bw = b.week || 0;
    if (bw !== aw) return bw - aw;
    const at = a.created || 0;
    const bt = b.created || 0;
    return bt - at;
  });

  let html = "<table><thead><tr>";
  html += "<th>Week</th><th>Type</th><th>Status</th><th>Adds</th><th>Drops</th><th>Waiver Bid</th>";
  html += "</tr></thead><tbody>";

  for (const t of rows) {
    html += "<tr>";
    html += `<td>${esc(t.week)}</td>`;
    html += `<td>${esc(t.type)}</td>`;
    html += `<td>${esc(t.status)}</td>`;
    html += `<td>${esc(formatAddsDrops(t.adds))}</td>`;
    html += `<td>${esc(formatAddsDrops(t.drops))}</td>`;
    html += `<td>${esc(t.waiver_bid ?? "")}</td>`;
    html += "</tr>";
  }

  html += "</tbody></table>";
  container.innerHTML = html;
}

// --------- INJURIES (LIVE ESPN) ---------
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
      const teamObj = team.team || team;
      const teamAbbr = teamObj.abbreviation || teamObj.shortName || "N/A";

      for (const injury of team.injuries || []) {
        const details = injury.details || {};
        let type = injury.type;
        if (typeof type === "object" && type !== null) {
          type = type.text || type.id || "";
        }
        const status = injury.status || "";
        const detail = details.detail || "";
        const returnDate = details.returnDate || details.returnDateText || "";

        injuries.push({
          player: injury.athlete?.displayName || "N/A",
          team: teamAbbr,
          status,
          type: type || "",
          detail,
          returnDate,
        });
      }
    }

    if (!injuries.length) {
      container.textContent = "No injuries reported.";
      return;
    }

    // Sort by team then player
    injuries.sort((a, b) => {
      const t = a.team.localeCompare(b.team);
      if (t !== 0) return t;
      return a.player.localeCompare(b.player);
    });

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
      "Could not load live injuries. ESPN may be blocking cross-origin requests; later we can add a backend proxy if needed.";
  }
}

// --------- INIT ---------
async function init() {
  setupTabs();

  let bundle;
  try {
    bundle = await loadDataBundle();
  } catch (err) {
    console.error(err);
    document.getElementById("meta").textContent = "Error loading data bundle.";
    return;
  }

  const leagueName = bundle.sleeper?.league?.name || "";
  renderMeta(bundle.meta, leagueName);
  renderOverviewPlayers(bundle);
  renderRostersTable(bundle);
  renderFreeAgentsTable(bundle);
  setupGameLogs(bundle);
  renderTransactions(bundle);

  // Live injuries on tab load
  fetchLiveInjuries();
}

init();
