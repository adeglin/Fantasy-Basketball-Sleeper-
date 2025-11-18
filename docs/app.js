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

// ============ BUILD nba.seasons + season_stats FROM RAW LOGS ============

function normalizeNBA(bundle) {
  const nba = bundle.nba || {};
  const logs = nba.game_logs || nba.logs || [];

  const seasons = {};
  const agg = {}; // per-season, per-player aggregation

  for (const g of logs) {
    const season = g.SEASON || g.season;
    if (!season) continue;

    // ensure season block exists
    if (!seasons[season]) {
      seasons[season] = {
        season,
        game_logs: [],
        season_stats: []
      };
      agg[season] = {};
    }

    seasons[season].game_logs.push(g);

    const name = g.PLAYER_NAME;
    if (!name) continue;
    if (!agg[season][name]) {
      agg[season][name] = {
        PLAYER_NAME: name,
        TEAM_ABBREVIATION: g.TEAM_ABBREVIATION || "",
        GP: 0,
        MIN: 0,
        PTS: 0,
        REB: 0,
        AST: 0
      };
    }

    // aggregate
    agg[season][name].GP += 1;
    agg[season][name].MIN += Number(g.MIN || 0);
    agg[season][name].PTS += Number(g.PTS || 0);
    agg[season][name].REB += Number(g.REB || 0);
    agg[season][name].AST += Number(g.AST || 0);
  }

  // attach season_stats arrays
  for (const season of Object.keys(seasons)) {
    const arr = Object.values(agg[season]);
    seasons[season].season_stats = arr;
  }

  // replace bundle.nba.seasons
  bundle.nba.seasons = seasons;
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

  if (!seasonBlock || !seasonBlock.season_stats?.length) {
    container.textContent = "No current season data available.";
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
        return (p.full_name || "").toLowerCase().includes(playerFilter);
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
      html += `<td><span class="pill pill-owner">${esc(r.display_name)}</span></td>`;
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

// ============ FREE AGENTS ============

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
  const hasSeasonStats =
    seasonBlock && Array.isArray(seasonBlock.season_stats) && seasonBlock.season_stats.length > 0;

  const owned = new Set(rostersPlayers.map(r => String(r.sleeper_player_id || "")));

  let candidateFA;

  if (hasSeasonStats) {
    const stats = seasonBlock.season_stats;
    const statsNameSet = new Set(stats.map((s) => normName(s.PLAYER_NAME)));

    candidateFA = players.filter((p) => {
      const id = String(p.sleeper_player_id || "");
      if (!id || owned.has(id)) return false;

      if (!p.team) return false;
      if (p.active === false) return false;

      const nm = normName(p.full_name);
      return statsNameSet.has(nm);
    });
  } else {
    candidateFA = players.filter((p) => {
      const id = String(p.sleeper_player_id || "");
      if (!id || owned.has(id)) return false;

      if (!p.team) return false;
      if (p.status === "RET") return false;
      if (p.active === false) return false;

      return true;
    });
  }

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

// ============ GAME LOGS ============

function setupGameLogs(bundle) {
  const seasonSelect = document.getElementById("gamelogs-season-select");
  const playerFilterInput = document.getElementById("gamelogs-player-filter");
  const container = document.getElementById("gamelogs-table");

  const seasonsObj = bundle.nba?.seasons || {};
  const seasons = Object.keys(seasonsObj);
  if (!seasons.length) {
    container.textContent = "No game logs available (nba.seasons is empty).";
    return;
  }

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
    const seasonBlock = seasonsObj[season];

    if (!seasonBlock) {
      container.textContent = "No logs for selected season.";
      return;
    }

    const logs = seasonBlock.game_logs || [];
    if (!logs.length) {
      container.textContent = "No logs for selected season (empty).";
      return;
    }

    const logsCopy = [...logs].sort((a, b) =>
      new Date(b.GAME_DATE) - new Date(a.GAME_DATE)
    );

    const filtered = logsCopy.filter((g) =>
      (g.PLAYER_NAME || "").toLowerCase().includes(playerFilter)
    );

    const rows = filtered.slice(0, 400);

    let recentThreshold = null;
    if (logsCopy.length) {
      const mostRecentDate = new Date(logsCopy[0].GAME_DATE);
      recentThreshold = new Date(mostRecentDate - 3 * 86400000);
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

// ============ TRANSACTIONS ============

function renderTransactions(bundle) {
  const container = document.getElementById("transactions-table");
  const txs = bundle.sleeper?.transactions || [];
  const players = bundle.sleeper?.players || [];
  const users = bundle.sleeper?.users || [];

  if (!txs.length) {
    container.textContent = "No transactions found.";
    return;
  }

  const playerMap = new Map();
  for (const p of players) {
    if (!p.sleeper_player_id) continue;
    playerMap.set(String(p.sleeper_player_id), p.full_name || p.sleeper_player_id);
  }

  const userMap = new Map();
  for (const u of users) {
    userMap.set(String(u.user_id), u.display_name || u.user_id);
  }

  function formatAddsDrops(obj) {
    if (!obj) return "";
    return Object.keys(obj)
      .map((pid) => playerMap.get(String(pid)) || pid)
      .join(", ");
  }

  const rows = [...txs].sort((a, b) => {
    if (b.week !== a.week) return b.week - a.week;
    return (b.created || 0) - (a.created || 0);
  });

  let html = "<table><thead><tr>";
  html += "<th>Week</th><th>Type</th><th>Status</th><th>Creator</th><th>Adds</th><th>Drops</th><th>Waiver Bid</th>";
  html += "</tr></thead><tbody>";

  for (const t of rows) {
    const creatorName = userMap.get(String(t.creator)) || "";

    html += "<tr>";
    html += `<td>${esc(t.week)}</td>`;
    html += `<td>${esc(t.type)}</td>`;
    html += `<td>${esc(t.status)}</td>`;
    html += `<td>${esc(creatorName)}</td>`;
    html += `<td>${esc(formatAddsDrops(t.adds))}</td>`;
    html += `<td>${esc(formatAddsDrops(t.drops))}</td>`;
    html += `<td>${esc(t.waiver_bid ?? "")}</td>`;
    html += "</tr>";
  }

  html += "</tbody></table>";
  container.innerHTML = html;
}

// ============ LIVE INJURIES ============

async function fetchLiveInjuries() {
  const container = document.getElementById("injuries-table");
  container.textContent = "Loading live injuries...";

  try {
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries", {
      cache: "no-cache",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const injuries = [];

    for (const team of data.injuries || []) {
      const tObj = team.team || team;
      const abbr =
        tObj.abbreviation ||
        tObj.shortName ||
        tObj.name ||
        tObj.displayName ||
        "N/A";

      for (const inj of team.injuries || []) {
        const details = inj.details || {};
        let type = inj.type;
        if (typeof type === "object") {
          type = type.text || type.description || type.id || "";
        }

        injuries.push({
          player: inj.athlete?.displayName || "N/A",
          team: abbr,
          status: inj.status || "",
          type: type || "",
          detail: details.detail || details.description || "",
          returnDate: details.returnDate || details.returnDateText || ""
        });
      }
    }

    if (!injuries.length) {
      container.textContent = "No injuries reported.";
      return;
    }

    injuries.sort((a, b) => {
      const t = a.team.localeCompare(b.team);
      if (t !== 0) return t;
      return a.player.localeCompare(b.player);
    });

    let html = "<table><thead><tr>";
    html += "<th>Player</th><th>Team</th><th>Status</th><th>Injury</th><th>Detail</th><th>Return</th>";
    html += "</tr></thead><tbody>";

    for (const inj of injuries) {
      html += "<tr>";
      html += `<td>${esc(inj.player)}</td>`;
      html += `<td>${esc(inj.team)}</td>`;
      html += `<td><span class="pill pill-inj">${esc(inj.status)}</span></td>`;
      html += `<td>${esc(inj.type)}</td>`;
      html += `<td>${esc(inj.detail)}</td>`;
      html += `<td>${esc(inj.returnDate)}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;

  } catch (err) {
    console.error("ESPN injuries error:", err);
    container.textContent = "Could not load live injuries (CORS issue or ESPN offline).";
  }
}

// ============ INIT ============

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

  // Build nba.seasons + season_stats automatically
  normalizeNBA(bundle);

  const leagueName = bundle.sleeper?.league?.name || "";
  renderMeta(bundle.meta, leagueName);
  renderOverviewPlayers(bundle);
  renderRostersTable(bundle);
  renderFreeAgentsTable(bundle);
  setupGameLogs(bundle);
  renderTransactions(bundle);

  fetchLiveInjuries();
}

init();
