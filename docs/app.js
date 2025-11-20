// ============ BASIC HELPERS ============

async function loadDataBundle() {
  // We prefer the new merged bundle: nba_historical.json
  // but fall back to data_bundle.json if needed.
  const candidates = [
    "./data/nba_historical.json",
    "./data/data_bundle.json",
  ];

  let lastError = null;

  for (const path of candidates) {
    try {
      const res = await fetch(path, { cache: "no-cache" });
      if (!res.ok) {
        console.warn(`Failed to load ${path}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const seasonsCount = json?.nba?.seasons
        ? Object.keys(json.nba.seasons).length
        : 0;
      console.log(
        `Loaded bundle from ${path}; seasons in nba.seasons = ${seasonsCount}`
      );
      return json;
    } catch (err) {
      console.warn(`Error loading ${path}:`, err);
      lastError = err;
    }
  }

  throw lastError || new Error("Could not load any data bundle JSON");
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

// ============ BUNDLE NORMALIZATION (KEY FIX) ============

function computeSeasonStatsFromLogs(logs) {
  const byKey = new Map();

  for (const g of logs || []) {
    const pid = g.PLAYER_ID ?? g.player_id ?? g.PLAYER_NAME ?? "";
    const team = g.TEAM_ABBREVIATION || g.TEAM_ABBR || "";
    const key = `${pid}|${team}`;

    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        PLAYER_ID: pid,
        PLAYER_NAME: g.PLAYER_NAME || g.player_name || "",
        TEAM_ABBREVIATION: team,
        GP: 0,
        MIN: 0,
        PTS: 0,
        REB: 0,
        AST: 0,
      };
      byKey.set(key, rec);
    }

    const min = Number(g.MIN) || 0;
    const pts = Number(g.PTS) || 0;
    // Some nba_api frames use REB, some use different naming, be defensive:
    const reb = Number(g.REB ?? g.TREB ?? g.REB_TOTAL ?? 0) || 0;
    const ast = Number(g.AST) || 0;

    rec.GP += 1;
    rec.MIN += min;
    rec.PTS += pts;
    rec.REB += reb;
    rec.AST += ast;
  }

  // Convert to per-game averages (1 decimal)
  for (const rec of byKey.values()) {
    if (rec.GP > 0) {
      rec.MIN = +(rec.MIN / rec.GP).toFixed(1);
      rec.PTS = +(rec.PTS / rec.GP).toFixed(1);
      rec.REB = +(rec.REB / rec.GP).toFixed(1);
      rec.AST = +(rec.AST / rec.GP).toFixed(1);
    }
  }

  return Array.from(byKey.values());
}

/**
 * Normalize whatever JSON the backend wrote into the shape
 * the frontend expects:
 *   bundle.meta.current_season
 *   bundle.nba.seasons[season].game_logs
 *   bundle.nba.seasons[season].season_stats
 */
function normalizeBundle(rawBundle) {
  const bundle = rawBundle || {};

  if (!bundle.meta) bundle.meta = {};

  // 1) Determine current season
  if (!bundle.meta.current_season) {
    const fromMetaSeason = bundle.meta.season;
    const fromNBA =
      bundle.nba?.seasons &&
      Object.keys(bundle.nba.seasons).length > 0
        ? Object.keys(bundle.nba.seasons)[0]
        : undefined;
    bundle.meta.current_season =
      bundle.meta.current_season || fromMetaSeason || fromNBA || "";
  }

  // 2) If nba.seasons already exists, keep it
  if (bundle.nba?.seasons && Object.keys(bundle.nba.seasons).length > 0) {
    return bundle;
  }

  // 3) If we have flat player_gamelogs, build nba.seasons on the fly
  if (!bundle.nba && Array.isArray(bundle.player_gamelogs)) {
    const logs = bundle.player_gamelogs;
    const seasonFromLogs = logs[0]?.SEASON_YEAR;
    const seasonKey =
      bundle.meta.current_season ||
      bundle.meta.season ||
      seasonFromLogs ||
      "Unknown";

    bundle.meta.current_season = seasonKey;

    const seasonStats = computeSeasonStatsFromLogs(logs);

    bundle.nba = {
      seasons: {
        [seasonKey]: {
          game_logs: logs,
          season_stats: seasonStats,
        },
      },
    };

    console.log(
      `normalizeBundle: built nba.seasons from player_gamelogs for season ${seasonKey}`
    );
    return bundle;
  }

  // 4) If no NBA data at all, leave as-is; callers will show "no data"
  if (!bundle.nba) {
    console.warn("normalizeBundle: bundle has no nba data at all");
  }

  return bundle;
}

// ============ META / OVERVIEW ============

function renderMeta(meta, leagueName) {
  const el = document.getElementById("meta");
  const namePart = leagueName ? ` | League: ${leagueName}` : "";
  const currentSeason = meta.current_season || meta.season || "";
  el.textContent = `Last updated (UTC): ${
    meta.generated_at_utc || "unknown"
  } | Current season: ${currentSeason}${namePart}`;
}

function renderOverviewPlayers(bundle) {
  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];
  const container = document.getElementById("overview-players-table");

  if (
    !seasonBlock ||
    !seasonBlock.season_stats ||
    !seasonBlock.season_stats.length
  ) {
    container.textContent = "No current season data available.";
    console.warn(
      "No season_stats found for",
      currentSeason,
      bundle.nba?.seasons
    );
    return;
  }

  const stats = seasonBlock.season_stats;
  const sorted = [...stats]
    .sort((a, b) => (b.PTS ?? 0) - (a.PTS ?? 0))
    .slice(0, 150);

  let html = "<table><thead><tr>";
  html +=
    "<th>Player</th><th>Team</th><th>GP</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th>";
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

// ============ NBA STATS INDEX FOR CURRENT SEASON (FOR FREE AGENTS) ============

function buildSeasonStatsIndexForCurrentSeason(bundle) {
  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];

  if (!seasonBlock || !Array.isArray(seasonBlock.game_logs)) {
    console.warn("No game_logs for current season; cannot build stats index.");
    return null;
  }

  const logs = seasonBlock.game_logs;
  const byKey = new Map(); // key = normName(name) + '|' + TEAM_ABBR

  for (const g of logs) {
    const name = g.PLAYER_NAME || g.player_name || "";
    const team = g.TEAM_ABBREVIATION || g.TEAM_ABBR || "";
    const key = `${normName(name)}|${team}`;

    if (!name || !team) continue;

    let rec = byKey.get(key);
    if (!rec) {
      rec = {
        PLAYER_NAME: name,
        TEAM_ABBREVIATION: team,
        GP: 0,
        MIN: 0,
        PTS: 0,
        REB: 0,
        AST: 0,
        STL: 0,
        BLK: 0,
        TOV: 0,
        FGM: 0,
        FGA: 0,
        FTM: 0,
        FTA: 0,
        FG3M: 0,
        FPTS: 0,          // fantasy points per game (computed later)
        GAMES_MISSED: 0,  // computed later
      };
      byKey.set(key, rec);
    }

    rec.GP += 1;
    rec.MIN += Number(g.MIN) || 0;
    rec.PTS += Number(g.PTS) || 0;
    rec.REB += Number(g.REB ?? g.TREB ?? g.REB_TOTAL ?? 0) || 0;
    rec.AST += Number(g.AST) || 0;
    rec.STL += Number(g.STL ?? g.STEALS ?? 0) || 0;
    rec.BLK += Number(g.BLK ?? g.BLOCKS ?? 0) || 0;
    rec.TOV += Number(g.TOV ?? g.TO ?? 0) || 0;
    rec.FGM += Number(g.FGM ?? g.FG_MADE ?? 0) || 0;
    rec.FGA += Number(g.FGA ?? g.FG_ATTEMPTED ?? 0) || 0;
    rec.FTM += Number(g.FTM ?? g.FT_MADE ?? 0) || 0;
    rec.FTA += Number(g.FTA ?? g.FT_ATTEMPTED ?? 0) || 0;
    rec.FG3M += Number(g.FG3M ?? g.FG3_MADE ?? g.THREES_MADE ?? 0) || 0;
  }

  // Compute per-game averages, fantasy points, and games missed
  const teamGames = new Map(); // TEAM_ABBR -> max GP (proxy for games played)

  for (const rec of byKey.values()) {
    if (rec.GP > 0) {
      rec.MIN = +(rec.MIN / rec.GP).toFixed(1);
      rec.PTS = +(rec.PTS / rec.GP).toFixed(1);
      rec.REB = +(rec.REB / rec.GP).toFixed(1);
      rec.AST = +(rec.AST / rec.GP).toFixed(1);
      rec.STL = +(rec.STL / rec.GP).toFixed(1);
      rec.BLK = +(rec.BLK / rec.GP).toFixed(1);
      rec.TOV = +(rec.TOV / rec.GP).toFixed(1);
      rec.FGM = +(rec.FGM / rec.GP).toFixed(1);
      rec.FGA = +(rec.FGA / rec.GP).toFixed(1);
      rec.FTM = +(rec.FTM / rec.GP).toFixed(1);
      rec.FTA = +(rec.FTA / rec.GP).toFixed(1);
      rec.FG3M = +(rec.FG3M / rec.GP).toFixed(1);

      // Sleeper scoring:
      // PTS: +1, REB: +1, AST: +2, STL: +4, BLK: +4, TOV: -2,
      // FGM: +2, FGA: -1, FTM: +1, FTA: -1, 3PM: +1
      const fpts =
        rec.PTS * 1 +
        rec.REB * 1 +
        rec.AST * 2 +
        rec.STL * 4 +
        rec.BLK * 4 +
        rec.TOV * -2 +
        rec.FGM * 2 +
        rec.FGA * -1 +
        rec.FTM * 1 +
        rec.FTA * -1 +
        rec.FG3M * 1;

      rec.FPTS = +fpts.toFixed(1);
    }

    const team = rec.TEAM_ABBREVIATION || "";
    if (team) {
      const prev = teamGames.get(team) || 0;
      if (rec.GP > prev) teamGames.set(team, rec.GP);
    }
  }

  for (const rec of byKey.values()) {
    const team = rec.TEAM_ABBREVIATION || "";
    const maxGP = teamGames.get(team) || rec.GP;
    rec.GAMES_MISSED = Math.max(0, maxGP - rec.GP);
  }

  // Build two indexes: by name+team, and by name only (best GP)
  const byNameTeam = new Map();
  const byName = new Map();

  for (const rec of byKey.values()) {
    const keyNameTeam = `${normName(rec.PLAYER_NAME)}|${rec.TEAM_ABBREVIATION}`;
    byNameTeam.set(keyNameTeam, rec);

    const n = normName(rec.PLAYER_NAME);
    const existing = byName.get(n);
    if (!existing || rec.GP > existing.GP) {
      byName.set(n, rec);
    }
  }

  return { byNameTeam, byName };
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
    html +=
      "<th>Owner</th><th>Roster</th><th>Player</th><th>Team</th><th>Pos</th><th>Fantasy Pos</th><th>Injury</th>";
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
      html += `<td><span class="pill pill-owner">${esc(
        r.display_name || "Unknown"
      )}</span></td>`;
      html += `<td>${esc(r.roster_id)}</td>`;
      html += `<td>${esc(p.full_name || pid)}</td>`;
      html += `<td>${esc(p.team || "")}</td>`;
      html += `${
        pos ? `<td><span class="pill pill-pos">${esc(pos)}</span></td>` : "<td></td>"
      }`;
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

// ============ FREE AGENTS (ACTIVE CURRENT SEASON OR FALLBACK) ============

function renderFreeAgentsTable(bundle, injuryIndex) {
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
    seasonBlock &&
    Array.isArray(seasonBlock.game_logs) &&
    seasonBlock.game_logs.length > 0;

  // Index of NBA season stats for current season
  const statsIndex = hasSeasonStats
    ? buildSeasonStatsIndexForCurrentSeason(bundle)
    : null;

  // Which players are already owned in the league
  const owned = new Set();
  for (const r of rostersPlayers) {
    if (r.sleeper_player_id != null) {
      owned.add(String(r.sleeper_player_id));
    }
  }

  let candidateFA;

  if (hasSeasonStats) {
    // Preferred: active current-season NBA players with stats, not rostered
    candidateFA = players.filter((p) => {
      const id = String(p.sleeper_player_id || "");
      if (!id || owned.has(id)) return false;
      if (!p.team) return false;
      if (p.active === false) return false;

      // Only standard active contract players (exclude TWO-WAY, TEN-DAY, etc.)
      if (p.status && p.status !== "ACT") return false;

      const nm = normName(p.full_name);
      const team = (p.team || "").toUpperCase();
      const keyTeam = `${nm}|${team}`;

      if (!statsIndex) return false;

      const hasStats =
        statsIndex.byNameTeam.has(keyTeam) || statsIndex.byName.has(nm);
      return hasStats;
    });
  } else {
    // Fallback: no NBA stats available – use Sleeper only, still filter status
    candidateFA = players.filter((p) => {
      const id = String(p.sleeper_player_id || "");
      if (!id || owned.has(id)) return false;
      if (!p.team) return false;
      if (p.active === false) return false;
      if (p.status && p.status !== "ACT") return false;
      return true;
    });
  }

  const filterInput = document.getElementById("fa-player-filter");
  const posSelect = document.getElementById("fa-pos-filter");

  function lookupStatsForPlayer(p) {
    if (!statsIndex) return null;
    const nm = normName(p.full_name);
    const team = (p.team || "").toUpperCase();
    const keyTeam = `${nm}|${team}`;

    return (
      statsIndex.byNameTeam.get(keyTeam) ||
      statsIndex.byName.get(nm) ||
      null
    );
  }

  function lookupInjuryForPlayer(p) {
    if (!injuryIndex) return null;
    const nm = normName(p.full_name);
    const team = (p.team || "").toUpperCase();
    const keyTeam = `${nm}|${team}`;

    return (
      injuryIndex.get(keyTeam) ||
      injuryIndex.get(nm) ||
      null
    );
  }

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
        const fpos = (p.fantasy_positions || []).join(",");
        return fpos.includes(posFilter);
      });
    }

    rows = [...rows].sort((a, b) =>
      (a.full_name || "").localeCompare(b.full_name || "")
    );

    let html = "<table><thead><tr>";
    html +=
      "<th>Player</th><th>Team</th><th>Fantasy Pos</th>" +
      "<th>MIN</th><th>GP</th><th>Games Missed</th><th>FPTS</th>" +
      "<th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th>" +
      "<th>3PM</th><th>FGM</th><th>FGA</th><th>FTM</th><th>FTA</th>" +
      "<th>Injury</th>";
    html += "</tr></thead><tbody>";

    for (const p of rows) {
      const fpos = (p.fantasy_positions || []).join(", ");
      const stats = lookupStatsForPlayer(p);
      const inj = lookupInjuryForPlayer(p);

      const min = stats ? stats.MIN : "";
      const gp = stats ? stats.GP : "";
      const gm = stats ? stats.GAMES_MISSED : "";
      const fpts = stats ? stats.FPTS : "";

      const pts = stats ? stats.PTS : "";
      const reb = stats ? stats.REB : "";
      const ast = stats ? stats.AST : "";
      const stl = stats ? stats.STL : "";
      const blk = stats ? stats.BLK : "";
      const fg3m = stats ? stats.FG3M : "";
      const fgm = stats ? stats.FGM : "";
      const fga = stats ? stats.FGA : "";
      const ftm = stats ? stats.FTM : "";
      const fta = stats ? stats.FTA : "";

      let injDisplay = "";
      if (inj) {
        const parts = [];
        if (inj.status) parts.push(inj.status);
        if (inj.type) parts.push(inj.type);
        if (inj.detail) parts.push(inj.detail);
        if (inj.returnDate) parts.push(`Return: ${inj.returnDate}`);
        injDisplay = parts.join(" — ");
      }

      html += "<tr>";
      html += `<td>${esc(p.full_name || p.sleeper_player_id)}</td>`;
      html += `<td>${esc(p.team || "")}</td>`;
      html += `<td>${esc(fpos)}</td>`;
      html += `<td>${esc(min)}</td>`;
      html += `<td>${esc(gp)}</td>`;
      html += `<td>${esc(gm)}</td>`;
      html += `<td>${esc(fpts)}</td>`;
      html += `<td>${esc(pts)}</td>`;
      html += `<td>${esc(reb)}</td>`;
      html += `<td>${esc(ast)}</td>`;
      html += `<td>${esc(stl)}</td>`;
      html += `<td>${esc(blk)}</td>`;
      html += `<td>${esc(fg3m)}</td>`;
      html += `<td>${esc(fgm)}</td>`;
      html += `<td>${esc(fga)}</td>`;
      html += `<td>${esc(ftm)}</td>`;
      html += `<td>${esc(fta)}</td>`;
      html += `<td>${esc(injDisplay)}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;
  }

  filterInput.addEventListener("input", doRender);
  posSelect.addEventListener("change", doRender);

  doRender();
}

// ============ GAME LOGS / HISTORICAL BOX SCORES ============

function setupGameLogs(bundle) {
  const seasonSelect = document.getElementById("gamelogs-season-select");
  const playerFilterInput = document.getElementById("gamelogs-player-filter");
  const container = document.getElementById("gamelogs-table");

  const seasonsObj = bundle.nba?.seasons || {};
  const seasons = Object.keys(seasonsObj);
  if (!seasons.length) {
    container.textContent = "No game logs available (nba.seasons is empty).";
    console.warn("nba.seasons is empty in bundle", bundle.nba);
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
      container.textContent =
        "No logs for selected season (missing season block).";
      return;
    }

    const logs = seasonBlock.game_logs || [];
    if (!logs.length) {
      container.textContent =
        "No logs for selected season (game_logs is empty).";
      console.warn("game_logs empty for season", season, seasonBlock);
      return;
    }

    const logsCopy = [...logs].sort((a, b) => {
      const da = new Date(a.GAME_DATE);
      const db = new Date(b.GAME_DATE);
      return db - da;
    });

    const filtered = logsCopy.filter((g) =>
      (g.PLAYER_NAME || "").toLowerCase().includes(playerFilter)
    );

    const rows = filtered.slice(0, 400);

    let recentThreshold = null;
    if (logsCopy.length) {
      const mostRecentDate = new Date(logsCopy[0].GAME_DATE);
      recentThreshold = new Date(
        mostRecentDate.getTime() - 3 * 24 * 60 * 60 * 1000
      );
    }

    let html = "<table><thead><tr>";
    html +=
      "<th>Date</th><th>Player</th><th>Team</th><th>Matchup</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th>";
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

// ============ TRANSACTIONS (WITH OWNER) ============

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
    playerMap.set(
      String(p.sleeper_player_id),
      p.full_name || p.sleeper_player_id
    );
  }

  const userMap = new Map();
  for (const u of users) {
    userMap.set(String(u.user_id), u.display_name || u.user_id);
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

  const rows = [...txs].sort((a, b) => {
    const aw = a.week || 0;
    const bw = b.week || 0;
    if (bw !== aw) return bw - aw;
    const at = a.created || 0;
    const bt = b.created || 0;
    return bt - at;
  });

  let html = "<table><thead><tr>";
  html +=
    "<th>Week</th><th>Type</th><th>Status</th><th>Creator</th><th>Adds</th><th>Drops</th><th>Waiver Bid</th>";
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

// ============ LIVE INJURIES (ESPN) ============

async function fetchLiveInjuries() {
  const container = document.getElementById("injuries-table");
  container.textContent = "Loading live injuries...";

  try {
    const res = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries",
      {
        cache: "no-cache",
      }
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    const injuries = [];
    for (const team of data.injuries || []) {
      const teamObj = team.team || team;
      const teamAbbr =
        teamObj.abbreviation ||
        teamObj.shortName ||
        teamObj.name ||
        teamObj.displayName ||
        "N/A";

      for (const injury of team.injuries || []) {
        const details = injury.details || {};
        let type = injury.type;
        if (typeof type === "object" && type !== null) {
          type = type.text || type.description || type.id || "";
        }
        const status = injury.status || "";
        const detail = details.detail || details.description || "";
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
      return { injuries: [], injuryIndex: new Map() };
    }

    injuries.sort((a, b) => {
      const t = a.team.localeCompare(b.team);
      if (t !== 0) return t;
      return a.player.localeCompare(b.player);
    });

    // Render the injuries table (as before)
    let html = "<table><thead><tr>";
    html +=
      "<th>Player</th><th>Team</th><th>Status</th><th>Injury</th><th>Detail</th><th>Return</th>";
    html += "</tr></thead><tbody>";

    for (const inj of injuries) {
      const statusPill = `<span class="pill pill-inj">${esc(
        inj.status
      )}</span>`;
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

    // Build an index for cross-referencing:
    const injuryIndex = new Map();
    for (const inj of injuries) {
      const keyTeam = `${normName(inj.player)}|${(inj.team || "").toUpperCase()}`;
      injuryIndex.set(keyTeam, inj);

      const keyName = normName(inj.player);
      if (!injuryIndex.has(keyName)) {
        injuryIndex.set(keyName, inj);
      }
    }

    return { injuries, injuryIndex };
  } catch (err) {
    console.error("Error fetching live injuries:", err);
    container.textContent =
      "Could not load live injuries. ESPN may be blocking cross-origin requests; later we can add a backend proxy if needed.";
    return { injuries: [], injuryIndex: new Map() };
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

  // 🔧 Normalize the bundle so nba.seasons + current_season
  // are always present, even if backend only wrote player_gamelogs.
  bundle = normalizeBundle(bundle);

  // Fetch live injuries and build index (also renders Injuries tab)
  let injuryIndex = null;
  try {
    const injuryData = await fetchLiveInjuries();
    injuryIndex = injuryData.injuryIndex || new Map();
  } catch (e) {
    console.warn("Injuries fetch failed; continuing without injury index.", e);
    injuryIndex = new Map();
  }

  const leagueName = bundle.sleeper?.league?.name || "";
  renderMeta(bundle.meta, leagueName);
  renderOverviewPlayers(bundle);
  renderRostersTable(bundle);
  renderFreeAgentsTable(bundle, injuryIndex);
  setupGameLogs(bundle);
  renderTransactions(bundle);
}

init();

