// ============ GLOBAL STATE ============

const APP_STATE = {
  bundle: null,
  injuriesByName: new Map(), // normName -> [injury...]
  faRows: [],                // processed free agent rows with stats
  faSortKey: "fptsPerGame",
  faSortDir: "desc",         // "asc" or "desc"
};

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

// Small numeric helper
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// Monday–Sunday week key (UTC) for "lock in" weekly high
function getWeekKey(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  const day = d.getUTCDay(); // 0=Sun,...6=Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`; // Monday date string
}

// ============ FANTASY SCORING HELPERS ============

// Your league scoring:
//
// Points Scored  +1
// Rebound        +1
// Assist         +2
// Steal          +4
// Block          +4
// Turnover       -2
// Field Goals M  +2
// Field Goals A  -1
// Free Throws M  +1
// Free Throws A  -1
// 3PM            +1

function computeFantasyPointsFromLog(g) {
  const pts = num(g.PTS);
  const reb = num(g.REB ?? g.TREB ?? g.REB_TOTAL);
  const ast = num(g.AST);
  const stl = num(g.STL);
  const blk = num(g.BLK);
  const tov = num(g.TOV ?? g.TO);
  const fgm = num(g.FGM ?? g.FG);
  const fga = num(g.FGA);
  const ftm = num(g.FTM);
  const fta = num(g.FTA);
  const fg3m = num(g.FG3M ?? g.FG3 ?? g["3PM"]);

  return (
    pts * 1 +
    reb * 1 +
    ast * 2 +
    stl * 4 +
    blk * 4 +
    tov * -2 +
    fgm * 2 +
    fga * -1 +
    ftm * 1 +
    fta * -1 +
    fg3m * 1
  );
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

    const min = num(g.MIN);
    const pts = num(g.PTS);
    const reb = num(g.REB ?? g.TREB ?? g.REB_TOTAL ?? 0);
    const ast = num(g.AST);

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
      bundle.nba?.seasons && Object.keys(bundle.nba.seasons).length > 0
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
      "<th>Owner</th><th>Roster</th><th>Player</th><th>Team</th><th>Fantasy Pos</th><th>Injury</th>";
    html += "</tr></thead><tbody>";

    for (const r of rows) {
      const pid = String(r.sleeper_player_id);
      const p = playerMap.get(pid) || {};
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

// ============ FREE AGENTS (ACTIVE + STATS + INJURIES) ============

// Build the FA data objects with:
// - Sleeper metadata
// - current-season averages (MIN, PTS, REB, AST, STL, BLK, TOV, FGM, FGA, FTM, FTA, FG3M)
// - FPTS per game
// - Weekly "lock-in" high average
// - Games played (GP) and games missed this season
// - Injuries from ESPN (by name)

function prepareFreeAgentsData(bundle) {
  const rostersPlayers = bundle.sleeper?.rosters_players || [];
  const players = bundle.sleeper?.players || [];
  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];
  const logs = seasonBlock?.game_logs || [];

  if (!players.length) {
    APP_STATE.faRows = [];
    return;
  }

  // Owned set
  const owned = new Set();
  for (const r of rostersPlayers) {
    if (r.sleeper_player_id != null) {
      owned.add(String(r.sleeper_player_id));
    }
  }

  // Index logs by normalized name (current season only)
  const logsByName = new Map();
  for (const g of logs) {
    const nm = normName(g.PLAYER_NAME);
    if (!nm) continue;
    let arr = logsByName.get(nm);
    if (!arr) {
      arr = [];
      logsByName.set(nm, arr);
    }
    arr.push(g);
  }

  // Compute max games played by any player this season (for "games missed" baseline)
  let maxGP = 0;
  for (const arr of logsByName.values()) {
    if (arr.length > maxGP) maxGP = arr.length;
  }

  const faRows = [];

  const injuriesByName = APP_STATE.injuriesByName || new Map();

  const candidateFA = players.filter((p) => {
    const id = String(p.sleeper_player_id || "");
    if (!id || owned.has(id)) return false;

    // Must be on a team & active
    if (!p.team) return false;
    if (p.active === false) return false;

    // Status: only show ACT (or empty), hide TWO-WAY / TEN-DAY etc.
    const status = (p.status || "").toUpperCase();
    if (status && status !== "ACT") return false;

    return true;
  });

  for (const p of candidateFA) {
    const nm = normName(p.full_name);
    const playerLogs = logsByName.get(nm) || [];
    const gp = playerLogs.length;

    let sumMin = 0;
    let sumPts = 0;
    let sumReb = 0;
    let sumAst = 0;
    let sumStl = 0;
    let sumBlk = 0;
    let sumTov = 0;
    let sumFgm = 0;
    let sumFga = 0;
    let sumFtm = 0;
    let sumFta = 0;
    let sumFg3m = 0;
    let sumFpts = 0;

    const weeklyHighMap = new Map(); // weekKey -> max FPTS in that week

    for (const g of playerLogs) {
      const min = num(g.MIN);
      const pts = num(g.PTS);
      const reb = num(g.REB ?? g.TREB ?? g.REB_TOTAL ?? 0);
      const ast = num(g.AST);
      const stl = num(g.STL);
      const blk = num(g.BLK);
      const tov = num(g.TOV ?? g.TO);
      const fgm = num(g.FGM ?? g.FG);
      const fga = num(g.FGA);
      const ftm = num(g.FTM);
      const fta = num(g.FTA);
      const fg3m = num(g.FG3M ?? g.FG3 ?? g["3PM"]);
      const fpts = computeFantasyPointsFromLog(g);

      sumMin += min;
      sumPts += pts;
      sumReb += reb;
      sumAst += ast;
      sumStl += stl;
      sumBlk += blk;
      sumTov += tov;
      sumFgm += fgm;
      sumFga += fga;
      sumFtm += ftm;
      sumFta += fta;
      sumFg3m += fg3m;
      sumFpts += fpts;

      const d = new Date(g.GAME_DATE);
      if (!isNaN(d.getTime())) {
        const wk = getWeekKey(d);
        const prev = weeklyHighMap.get(wk);
        if (prev == null || fpts > prev) {
          weeklyHighMap.set(wk, fpts);
        }
      }
    }

    const avg = (sum, count) =>
      count > 0 ? +(sum / count).toFixed(1) : 0;

    const fptsPerGame = avg(sumFpts, gp);
    const weeklyHighValues = Array.from(weeklyHighMap.values());
    const weeklyHighAvg =
      weeklyHighValues.length > 0
        ? +(
            weeklyHighValues.reduce((a, b) => a + b, 0) /
            weeklyHighValues.length
          ).toFixed(1)
        : 0;

    // Games missed this season = maxGP - gp (clamped to >= 0)
    let gamesMissed = 0;
    if (maxGP > 0 && gp >= 0) {
      gamesMissed = Math.max(0, maxGP - gp);
    }

    const injuryList = injuriesByName.get(nm) || [];
    const injuryText = formatInjuryDisplay(injuryList);

    faRows.push({
      sleeper: p,
      nameNorm: nm,
      team: p.team || "",
      fantasyPos: (p.fantasy_positions || []).join(", "),
      status: p.status || "",
      stats: {
        gp,
        gamesMissed,
        min: avg(sumMin, gp),
        pts: avg(sumPts, gp),
        reb: avg(sumReb, gp),
        ast: avg(sumAst, gp),
        stl: avg(sumStl, gp),
        blk: avg(sumBlk, gp),
        tov: avg(sumTov, gp),
        fgm: avg(sumFgm, gp),
        fga: avg(sumFga, gp),
        ftm: avg(sumFtm, gp),
        fta: avg(sumFta, gp),
        fg3m: avg(sumFg3m, gp),
        fptsPerGame,
        weeklyHighAvg,
      },
      injuriesText: injuryText,
      playsToday: false,     // to be wired if/when schedule data exists
      playsTomorrow: false,  // "
      playsDayAfter: false,  // "
    });
  }

  APP_STATE.faRows = faRows;
}

// Format injuries for display in a single column
function formatInjuryDisplay(injuries) {
  if (!injuries || !injuries.length) return "";

  return injuries
    .map((inj) => {
      const parts = [];
      if (inj.status) parts.push(inj.status);
      if (inj.type) parts.push(inj.type);
      if (inj.detail) parts.push(inj.detail);
      if (inj.startDate) parts.push(`Since: ${inj.startDate}`);
      if (inj.returnDate) parts.push(`Return: ${inj.returnDate}`);
      return parts.join(" — ");
    })
    .join(" | ");
}

// Get sort value for FA row
function getFaSortValue(row, key) {
  const s = row.stats;
  switch (key) {
    case "name":
      return row.sleeper.full_name || "";
    case "team":
      return row.team || "";
    case "fantasyPos":
      return row.fantasyPos || "";
    case "gp":
      return s.gp;
    case "gamesMissed":
      return s.gamesMissed;
    case "min":
      return s.min;
    case "pts":
      return s.pts;
    case "reb":
      return s.reb;
    case "ast":
      return s.ast;
    case "stl":
      return s.stl;
    case "blk":
      return s.blk;
    case "tov":
      return s.tov;
    case "fgm":
      return s.fgm;
    case "fga":
      return s.fga;
    case "ftm":
      return s.ftm;
    case "fta":
      return s.fta;
    case "fg3m":
      return s.fg3m;
    case "fptsPerGame":
      return s.fptsPerGame;
    case "weeklyHighAvg":
      return s.weeklyHighAvg;
    default:
      return 0;
  }
}

// Main render function for Free Agents tab
function renderFreeAgentsTable() {
  const bundle = APP_STATE.bundle;
  const container = document.getElementById("fa-table");
  const filterInput = document.getElementById("fa-player-filter");
  const posSelect = document.getElementById("fa-pos-filter");
  const gameFilterSelect = document.getElementById("fa-game-filter"); // NEW

  if (!bundle || !APP_STATE.faRows.length) {
    container.textContent = "No Sleeper free agents available.";
    return;
  }

  const nameFilter = (filterInput?.value || "").toLowerCase();
  const posFilter = posSelect?.value || "";
  const gameFilter = gameFilterSelect?.value || ""; // "", "today", "tomorrow", "day2"

  let rows = APP_STATE.faRows;

  if (nameFilter) {
    rows = rows.filter((r) =>
      (r.sleeper.full_name || "").toLowerCase().includes(nameFilter)
    );
  }

  if (posFilter) {
    rows = rows.filter((r) => {
      const fpos = r.fantasyPos || "";
      return fpos.includes(posFilter);
    });
  }

  if (gameFilter) {
    rows = rows.filter((r) => {
      if (gameFilter === "today") return !!r.playsToday;
      if (gameFilter === "tomorrow") return !!r.playsTomorrow;
      if (gameFilter === "day2") return !!r.playsDayAfter;
      return true;
    });
  }

  // Sort rows
  const sortKey = APP_STATE.faSortKey;
  const sortDir = APP_STATE.faSortDir === "asc" ? 1 : -1;

  rows = [...rows].sort((a, b) => {
    const av = getFaSortValue(a, sortKey);
    const bv = getFaSortValue(b, sortKey);

    if (typeof av === "string" || typeof bv === "string") {
      return sortDir * String(av).localeCompare(String(bv));
    }

    return sortDir * (bv - av);
  });

  let html = "<table><thead><tr>";
  // Player (clickable) + Team + FantasyPos
  html += `<th data-sort-key="name">Player</th>`;
  html += `<th data-sort-key="team">Team</th>`;
  html += `<th data-sort-key="fantasyPos">Fantasy Pos</th>`;
  // Grouped: GP / G Missed
  html += `<th data-sort-key="gp">GP</th>`;
  html += `<th data-sort-key="gamesMissed">G Missed</th>`;
  // Core averages
  html += `<th data-sort-key="min">MIN</th>`;
  html += `<th data-sort-key="pts">PTS</th>`;
  html += `<th data-sort-key="reb">REB</th>`;
  html += `<th data-sort-key="ast">AST</th>`;
  html += `<th data-sort-key="stl">STL</th>`;
  html += `<th data-sort-key="blk">BLK</th>`;
  html += `<th data-sort-key="tov">TOV</th>`;
  html += `<th data-sort-key="fgm">FGM</th>`;
  html += `<th data-sort-key="fga">FGA</th>`;
  html += `<th data-sort-key="ftm">FTM</th>`;
  html += `<th data-sort-key="fta">FTA</th>`;
  html += `<th data-sort-key="fg3m">3PM</th>`;
  // Grouped: FPTS / Weekly High Avg
  html += `<th data-sort-key="fptsPerGame">FPTS</th>`;
  html += `<th data-sort-key="weeklyHighAvg">Weekly High Avg</th>`;
  // Injuries (last column, non-sortable or sortable if you want)
  html += `<th>Injuries</th>`;
  html += "</tr></thead><tbody>";

  for (const row of rows) {
    const p = row.sleeper;
    const s = row.stats;

    html += "<tr>";
    // Player name as clickable link for detail modal
    html += `<td><button class="fa-player-detail" data-player-name="${esc(
      p.full_name || ""
    )}" data-player-id="${esc(
      String(p.sleeper_player_id || "")
    )}">${esc(p.full_name || p.sleeper_player_id)}</button></td>`;
    html += `<td>${esc(row.team)}</td>`;
    html += `<td>${esc(row.fantasyPos)}</td>`;
    html += `<td>${esc(s.gp)}</td>`;
    html += `<td>${esc(s.gamesMissed)}</td>`;
    html += `<td>${esc(s.min)}</td>`;
    html += `<td>${esc(s.pts)}</td>`;
    html += `<td>${esc(s.reb)}</td>`;
    html += `<td>${esc(s.ast)}</td>`;
    html += `<td>${esc(s.stl)}</td>`;
    html += `<td>${esc(s.blk)}</td>`;
    html += `<td>${esc(s.tov)}</td>`;
    html += `<td>${esc(s.fgm)}</td>`;
    html += `<td>${esc(s.fga)}</td>`;
    html += `<td>${esc(s.ftm)}</td>`;
    html += `<td>${esc(s.fta)}</td>`;
    html += `<td>${esc(s.fg3m)}</td>`;
    html += `<td>${esc(s.fptsPerGame)}</td>`;
    html += `<td>${esc(s.weeklyHighAvg)}</td>`;
    html += `<td>${esc(row.injuriesText)}</td>`;
    html += "</tr>";
  }

  html += "</tbody></table>";
  container.innerHTML = html;

  // Wire sorting on header click
  const headers = container.querySelectorAll("thead th[data-sort-key]");
  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (!key) return;
      if (APP_STATE.faSortKey === key) {
        APP_STATE.faSortDir = APP_STATE.faSortDir === "asc" ? "desc" : "asc";
      } else {
        APP_STATE.faSortKey = key;
        APP_STATE.faSortDir = "desc";
      }
      renderFreeAgentsTable();
    });
  });

  // Wire player detail click (modal)
  const buttons = container.querySelectorAll(".fa-player-detail");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.playerName || "";
      showPlayerDetailsModal(name);
    });
  });
}

// ============ PLAYER DETAIL MODAL (GAME LOGS + PRIOR SEASONS) ============

function showPlayerDetailsModal(fullName) {
  const bundle = APP_STATE.bundle;
  if (!bundle) return;
  const nameNorm = normName(fullName);

  const modal = document.getElementById("player-modal");
  const body = document.getElementById("player-modal-body");
  const closeBtn = document.getElementById("player-modal-close");

  if (!modal || !body) {
    alert(
      "Player detail modal container not found. Please ensure the HTML includes #player-modal, #player-modal-body, and #player-modal-close."
    );
    return;
  }

  const seasonsObj = bundle.nba?.seasons || {};
  const seasons = Object.keys(seasonsObj).sort();

  const perSeasonLogs = {}; // season -> logs[]
  for (const seasonKey of seasons) {
    const logs = seasonsObj[seasonKey]?.game_logs || [];
    const matched = logs.filter(
      (g) => normName(g.PLAYER_NAME) === nameNorm
    );
    if (matched.length) {
      perSeasonLogs[seasonKey] = matched;
    }
  }

  const currentSeason = bundle.meta.current_season;
  const currentLogs = perSeasonLogs[currentSeason] || [];

  function summarizeSeason(logs) {
    let gCount = logs.length;
    let sumMin = 0;
    let sumPts = 0;
    let sumReb = 0;
    let sumAst = 0;
    let sumStl = 0;
    let sumBlk = 0;
    let sumTov = 0;
    let sumFpts = 0;

    for (const g of logs) {
      sumMin += num(g.MIN);
      sumPts += num(g.PTS);
      sumReb += num(g.REB ?? g.TREB ?? g.REB_TOTAL ?? 0);
      sumAst += num(g.AST);
      sumStl += num(g.STL);
      sumBlk += num(g.BLK);
      sumTov += num(g.TOV ?? g.TO);
      sumFpts += computeFantasyPointsFromLog(g);
    }

    const avg = (sum, count) =>
      count > 0 ? +(sum / count).toFixed(1) : 0;

    return {
      gp: gCount,
      min: avg(sumMin, gCount),
      pts: avg(sumPts, gCount),
      reb: avg(sumReb, gCount),
      ast: avg(sumAst, gCount),
      stl: avg(sumStl, gCount),
      blk: avg(sumBlk, gCount),
      tov: avg(sumTov, gCount),
      fpts: avg(sumFpts, gCount),
    };
  }

  // Build HTML for modal
  let html = `<h2>${esc(fullName)}</h2>`;

  // Current season summary
  if (currentLogs.length) {
    const summary = summarizeSeason(currentLogs);
    html += `<h3>Current Season (${esc(currentSeason)}) Averages</h3>`;
    html += "<ul>";
    html += `<li>GP: ${esc(summary.gp)}</li>`;
    html += `<li>MIN: ${esc(summary.min)}</li>`;
    html += `<li>PTS: ${esc(summary.pts)}</li>`;
    html += `<li>REB: ${esc(summary.reb)}</li>`;
    html += `<li>AST: ${esc(summary.ast)}</li>`;
    html += `<li>STL: ${esc(summary.stl)}</li>`;
    html += `<li>BLK: ${esc(summary.blk)}</li>`;
    html += `<li>TOV: ${esc(summary.tov)}</li>`;
    html += `<li>FPTS: ${esc(summary.fpts)}</li>`;
    html += "</ul>";
  } else {
    html += `<p>No current-season logs found for ${esc(fullName)}.</p>`;
  }

  // Previous seasons summary
  const previousSeasons = seasons.filter(
    (s) => s !== currentSeason && perSeasonLogs[s]?.length
  );
  if (previousSeasons.length) {
    html += "<h3>Previous Seasons Averages</h3>";
    html += "<ul>";
    for (const s of previousSeasons) {
      const summary = summarizeSeason(perSeasonLogs[s]);
      html += `<li><strong>${esc(s)}</strong>: GP ${esc(
        summary.gp
      )}, MIN ${esc(summary.min)}, PTS ${esc(
        summary.pts
      )}, REB ${esc(summary.reb)}, AST ${esc(
        summary.ast
      )}, ST ${esc(summary.stl)}, BLK ${esc(
        summary.blk
      )}, TOV ${esc(summary.tov)}, FPTS ${esc(summary.fpts)}</li>`;
    }
    html += "</ul>";
  }

  // Game logs table for current season (including FPTS)
  if (currentLogs.length) {
    const sortedLogs = [...currentLogs].sort((a, b) => {
      const da = new Date(a.GAME_DATE);
      const db = new Date(b.GAME_DATE);
      return db - da;
    });

    html += `<h3>Current Season Game Logs</h3>`;
    html += "<div class='player-logs-table-wrapper'>";
    html += "<table><thead><tr>";
    html +=
      "<th>Date</th><th>Team</th><th>Matchup</th><th>MIN</th><th>PTS</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>TOV</th><th>3PM</th><th>FPTS</th>";
    html += "</tr></thead><tbody>";

    for (const g of sortedLogs) {
      const fpts = computeFantasyPointsFromLog(g);
      html += "<tr>";
      html += `<td>${esc(g.GAME_DATE)}</td>`;
      html += `<td>${esc(g.TEAM_ABBREVIATION || "")}</td>`;
      html += `<td>${esc(g.MATCHUP || "")}</td>`;
      html += `<td>${esc(g.MIN)}</td>`;
      html += `<td>${esc(g.PTS)}</td>`;
      html += `<td>${esc(g.REB ?? g.TREB ?? g.REB_TOTAL ?? "")}</td>`;
      html += `<td>${esc(g.AST)}</td>`;
      html += `<td>${esc(g.STL)}</td>`;
      html += `<td>${esc(g.BLK)}</td>`;
      html += `<td>${esc(g.TOV ?? g.TO ?? "")}</td>`;
      html += `<td>${esc(g.FG3M ?? g.FG3 ?? g["3PM"] ?? "")}</td>`;
      html += `<td>${esc(+fpts.toFixed(1))}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    html += "</div>";
  }

  body.innerHTML = html;
  modal.classList.add("open");

  if (closeBtn) {
    closeBtn.onclick = () => modal.classList.remove("open");
  }

  modal.addEventListener("click", (evt) => {
    if (evt.target === modal) {
      modal.classList.remove("open");
    }
  });
}

// ============ GAME LOGS / HISTORICAL BOX SCORES (TAB) ============

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

// Now returns the injuries array and also renders Injuries tab.
async function loadInjuriesAndRenderTab() {
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

        // Try to get when the injury started, if ESPN provides anything
        const startDate =
          details.injuryDate ||
          details.date ||
          details.injuryStartDate ||
          "";
        const returnDate =
          details.returnDate ||
          details.returnDateText ||
          details.expectedReturn ||
          "";

        injuries.push({
          player: injury.athlete?.displayName || "N/A",
          team: teamAbbr,
          status,
          type: type || "",
          detail,
          startDate,
          returnDate,
        });
      }
    }

    // Build index by normalized player name for FA tab
    const injMap = new Map();
    for (const inj of injuries) {
      const nm = normName(inj.player);
      if (!nm) continue;
      let arr = injMap.get(nm);
      if (!arr) {
        arr = [];
        injMap.set(nm, arr);
      }
      arr.push(inj);
    }
    APP_STATE.injuriesByName = injMap;

    if (!injuries.length) {
      container.textContent = "No injuries reported.";
      return injuries;
    }

    injuries.sort((a, b) => {
      const t = a.team.localeCompare(b.team);
      if (t !== 0) return t;
      return a.player.localeCompare(b.player);
    });

    let html = "<table><thead><tr>";
    html +=
      "<th>Player</th><th>Team</th><th>Status</th><th>Injury</th><th>Detail</th><th>Since</th><th>Return</th>";
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
      html += `<td>${esc(inj.startDate || "")}</td>`;
      html += `<td>${esc(inj.returnDate || "")}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;

    return injuries;
  } catch (err) {
    console.error("Error fetching live injuries:", err);
    container.textContent =
      "Could not load live injuries. ESPN may be blocking cross-origin requests; later we can add a backend proxy if needed.";
    return [];
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

  bundle = normalizeBundle(bundle);
  APP_STATE.bundle = bundle;

  const leagueName = bundle.sleeper?.league?.name || "";
  renderMeta(bundle.meta, leagueName);
  renderOverviewPlayers(bundle);
  renderRostersTable(bundle);

  // Load injuries first (for both Injuries tab AND FA tab)
  await loadInjuriesAndRenderTab();

  // Now that injuries map is ready, prepare FA stats and render
  prepareFreeAgentsData(bundle);
  renderFreeAgentsTable();

  setupGameLogs(bundle);
  renderTransactions(bundle);
}

init();
