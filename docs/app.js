// ============ GLOBAL STATE ============

// Per-player season aggregates (by normalized name)
let gSeasonAggByNormName = null;
// Team -> number of games played (from logs)
let gTeamGamesByTeam = null;
// Per-player weekly lock-in average (by normalized name)
let gWeeklyHighAvgByNormName = null;
// Per-player ESPN injury info (by normalized name)
let gInjuriesByNormName = null;

// ============ BASIC HELPERS ============

async function loadDataBundle() {
  // We prefer the new merged bundle: nba_historical.json
  // but fall back to data_bundle.json if needed.
  const candidates = ["./data/nba_historical.json", "./data/data_bundle.json"];

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

// ============ NUMERIC / TIME HELPERS ============

function toNumber(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

// MIN comes from nba_api usually as "MM:SS"
function parseMinutesToFloat(minVal) {
  if (minVal == null) return 0;
  if (typeof minVal === "number") return minVal;
  if (typeof minVal !== "string") return 0;

  const trimmed = minVal.trim();
  if (!trimmed) return 0;

  if (trimmed.includes(":")) {
    const [mStr, sStr] = trimmed.split(":");
    const m = parseInt(mStr, 10) || 0;
    const s = parseInt(sStr, 10) || 0;
    return m + s / 60;
  }
  return toNumber(trimmed);
}

// Sleeper scoring for a single game log row
function computeFantasyPointsFromLog(g) {
  const pts = toNumber(g.PTS);
  const reb = toNumber(g.REB ?? g.TREB ?? g.REB_TOTAL);
  const ast = toNumber(g.AST);
  const stl = toNumber(g.STL);
  const blk = toNumber(g.BLK);
  const tov = toNumber(g.TOV);
  const fgm = toNumber(g.FGM);
  const fga = toNumber(g.FGA);
  const ftm = toNumber(g.FTM);
  const fta = toNumber(g.FTA);
  const threes =
    toNumber(g.FG3M ?? g["3PM"]) ||
    0; /* prefer made 3s; ignore FG3_PTS since that's points, not count */

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
    threes * 1
  );
}

function startOfWeekMonday(date) {
  const d = new Date(date.getTime());
  const day = (d.getDay() + 6) % 7; // 0 = Monday, 6 = Sunday
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ============ BUNDLE NORMALIZATION (FOR OVERVIEW) ============

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

    const min = parseMinutesToFloat(g.MIN);
    const pts = toNumber(g.PTS);
    const reb = toNumber(g.REB ?? g.TREB ?? g.REB_TOTAL);
    const ast = toNumber(g.AST);

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
      bundle.meta.current_season || bundle.meta.season || seasonFromLogs || "Unknown";

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

// ============ SEASON AGGREGATES FOR FREE AGENTS ============

function computeSeasonAggregatesForCurrentSeason(bundle) {
  gSeasonAggByNormName = new Map();
  gTeamGamesByTeam = new Map();
  gWeeklyHighAvgByNormName = new Map();

  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];
  if (!seasonBlock || !Array.isArray(seasonBlock.game_logs)) {
    console.warn("No game_logs for current season; FA stats will be empty.");
    return;
  }

  const logs = seasonBlock.game_logs;

  const statsByNormName = new Map(); // normName -> aggregate
  const teamGameIds = new Map(); // TEAM_ABBR -> Set(GAME_ID)
  const weeklyHighByPlayerWeek = new Map(); // `${normName}|YYYY-MM-DD` -> { fpts }

  for (const g of logs) {
    const rawName = g.PLAYER_NAME || g.player_name || "";
    const nName = normName(rawName);
    if (!nName) continue;

    const team = g.TEAM_ABBREVIATION || g.TEAM_ABBR || g.TEAM || "";
    const gameId =
      g.GAME_ID || `${g.GAME_DATE || ""}|${team}|${g.MATCHUP || ""}`;

    // Track team games
    if (team && gameId) {
      let set = teamGameIds.get(team);
      if (!set) {
        set = new Set();
        teamGameIds.set(team, set);
      }
      set.add(gameId);
    }

    // Per-player aggregates
    let rec = statsByNormName.get(nName);
    if (!rec) {
      rec = {
        name: rawName,
        team,
        gp: 0,
        minsTotal: 0,
        ptsTotal: 0,
        rebTotal: 0,
        astTotal: 0,
        stlTotal: 0,
        blkTotal: 0,
        tovTotal: 0,
        fgmTotal: 0,
        fgaTotal: 0,
        ftmTotal: 0,
        ftaTotal: 0,
        tpmTotal: 0,
        fptsTotal: 0,
      };
      statsByNormName.set(nName, rec);
    }

    rec.team = team || rec.team;

    rec.gp += 1;
    rec.minsTotal += parseMinutesToFloat(g.MIN);
    rec.ptsTotal += toNumber(g.PTS);
    rec.rebTotal += toNumber(g.REB ?? g.TREB ?? g.REB_TOTAL);
    rec.astTotal += toNumber(g.AST);
    rec.stlTotal += toNumber(g.STL);
    rec.blkTotal += toNumber(g.BLK);
    rec.tovTotal += toNumber(g.TOV);
    rec.fgmTotal += toNumber(g.FGM);
    rec.fgaTotal += toNumber(g.FGA);
    rec.ftmTotal += toNumber(g.FTM);
    rec.ftaTotal += toNumber(g.FTA);
    rec.tpmTotal += toNumber(g.FG3M ?? g["3PM"]);

    const fpts = computeFantasyPointsFromLog(g);
    rec.fptsTotal += fpts;

    // Weekly lock-in: max FPTS per Monday–Sunday week
    const dateStr = g.GAME_DATE || g.GAME_DATE_EST || g.game_date || "";
    if (dateStr) {
      const d = new Date(dateStr);
      if (!isNaN(d)) {
        const weekKey = `${nName}|${startOfWeekMonday(d)}`;
        const prev = weeklyHighByPlayerWeek.get(weekKey);
        if (!prev || fpts > prev.fpts) {
          weeklyHighByPlayerWeek.set(weekKey, { fpts });
        }
      }
    }
  }

  // Team -> #games
  const teamGamesByTeam = new Map();
  for (const [team, set] of teamGameIds.entries()) {
    teamGamesByTeam.set(team, set.size);
  }

  // Weekly lock-in averages per player
  const weeklySumByPlayer = new Map();
  const weeklyCountByPlayer = new Map();
  for (const [key, obj] of weeklyHighByPlayerWeek.entries()) {
    const [nName] = key.split("|");
    const prevSum = weeklySumByPlayer.get(nName) || 0;
    const prevCnt = weeklyCountByPlayer.get(nName) || 0;
    weeklySumByPlayer.set(nName, prevSum + obj.fpts);
    weeklyCountByPlayer.set(nName, prevCnt + 1);
  }

  const weeklyHighAvgByName = new Map();
  for (const [nName, sum] of weeklySumByPlayer.entries()) {
    const cnt = weeklyCountByPlayer.get(nName) || 1;
    weeklyHighAvgByName.set(nName, sum / cnt);
  }

  gSeasonAggByNormName = statsByNormName;
  gTeamGamesByTeam = teamGamesByTeam;
  gWeeklyHighAvgByNormName = weeklyHighAvgByName;
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

// ============ FREE AGENTS (WITH STATS + INJURIES) ============

function renderFreeAgentsTable(bundle) {
  const container = document.getElementById("fa-table");
  const rostersPlayers = bundle.sleeper?.rosters_players || [];
  const players = bundle.sleeper?.players || [];

  if (!players.length) {
    container.textContent = "No Sleeper players metadata available.";
    return;
  }

  // Which players are already owned in the league
  const owned = new Set();
  for (const r of rostersPlayers) {
    if (r.sleeper_player_id != null) {
      owned.add(String(r.sleeper_player_id));
    }
  }

  const filterInput = document.getElementById("fa-player-filter");
  const posSelect = document.getElementById("fa-pos-filter");

  let currentSortKey = "fptsPerGame"; // default sort
  let currentSortDir = -1; // -1 = desc, 1 = asc

  function isDisplayableStatus(status) {
    if (!status) return true; // treat missing as active
    if (status === "ACT") return true;
    // Explicitly hide TWO-WAY, TEN-DAY and any non-active status
    return false;
  }

  function getSeasonStatsForPlayer(p) {
    if (!gSeasonAggByNormName) return null;
    const nm = normName(p.full_name || "");
    return gSeasonAggByNormName.get(nm) || null;
  }

  function getWeeklyHighAvgForPlayer(p) {
    if (!gWeeklyHighAvgByNormName) return 0;
    const nm = normName(p.full_name || "");
    const val = gWeeklyHighAvgByNormName.get(nm);
    return val != null ? val : 0;
  }

  function getGamesMissedForPlayer(p, stats) {
    if (!gTeamGamesByTeam) return "";
    const team = (stats && stats.team) || p.team || "";
    if (!team) return "";
    const teamGames = gTeamGamesByTeam.get(team) || 0;
    const gp = stats?.gp || 0;
    if (!teamGames) return "";
    return Math.max(0, teamGames - gp);
  }

  function getInjuryInfoForPlayer(p) {
    if (!gInjuriesByNormName) return "";
    const nm = normName(p.full_name || "");
    const arr = gInjuriesByNormName.get(nm);
    if (!arr || !arr.length) return "";
    return arr
      .map((inj) => {
        const bits = [];
        if (inj.status) bits.push(inj.status);
        if (inj.type) bits.push(inj.type);
        if (inj.detail) bits.push(inj.detail);
        if (inj.started) bits.push(`since ${inj.started}`);
        if (inj.returnDate) bits.push(`return: ${inj.returnDate}`);
        return bits.join(" — ");
      })
      .join(" | ");
  }

  function getSortValue(row, key) {
    const p = row.p;
    const s = row.stats || {};
    switch (key) {
      case "name":
        return (p.full_name || "").toLowerCase();
      case "team":
        return (p.team || "").toLowerCase();
      case "fpos":
        return (p.fantasy_positions || []).join(",").toLowerCase();
      case "gp":
        return s.gp || 0;
      case "gmiss":
        return row.gamesMissed || 0;
      case "minPerGame":
        return s.gp ? s.minsTotal / s.gp : 0;
      case "fptsPerGame":
        return s.gp ? s.fptsTotal / s.gp : 0;
      case "weeklyHighAvg":
        return row.weeklyHighAvg || 0;
      case "ptsPerGame":
        return s.gp ? s.ptsTotal / s.gp : 0;
      case "rebPerGame":
        return s.gp ? s.rebTotal / s.gp : 0;
      case "astPerGame":
        return s.gp ? s.astTotal / s.gp : 0;
      case "stlPerGame":
        return s.gp ? s.stlTotal / s.gp : 0;
      case "blkPerGame":
        return s.gp ? s.blkTotal / s.gp : 0;
      case "tovPerGame":
        return s.gp ? s.tovTotal / s.gp : 0;
      case "fgmPerGame":
        return s.gp ? s.fgmTotal / s.gp : 0;
      case "fgaPerGame":
        return s.gp ? s.fgaTotal / s.gp : 0;
      case "ftmPerGame":
        return s.gp ? s.ftmTotal / s.gp : 0;
      case "ftaPerGame":
        return s.gp ? s.ftaTotal / s.gp : 0;
      case "tpmPerGame":
        return s.gp ? s.tpmTotal / s.gp : 0;
      default:
        return 0;
    }
  }

  function compareRows(a, b) {
    const va = getSortValue(a, currentSortKey);
    const vb = getSortValue(b, currentSortKey);

    if (typeof va === "string" || typeof vb === "string") {
      return currentSortDir * String(va).localeCompare(String(vb));
    }
    return currentSortDir * (va - vb);
  }

  function buildRows() {
    const nameFilter = (filterInput.value || "").toLowerCase();
    const posFilter = posSelect.value || "";

    let rows = players.filter((p) => {
      const id = String(p.sleeper_player_id || "");
      if (!id || owned.has(id)) return false;
      if (!p.team) return false; // must be on an NBA team
      if (p.status === "RET") return false;
      if (p.active === false) return false;
      if (!isDisplayableStatus(p.status)) return false;

      if (nameFilter) {
        if (!(p.full_name || "").toLowerCase().includes(nameFilter)) {
          return false;
        }
      }

      if (posFilter) {
        const pos = p.position || "";
        const fpos = (p.fantasy_positions || []).join(",");
        if (!pos.includes(posFilter) && !fpos.includes(posFilter)) {
          return false;
        }
      }

      return true;
    });

    rows = rows.map((p) => {
      const stats = getSeasonStatsForPlayer(p);
      const weeklyHighAvg = getWeeklyHighAvgForPlayer(p);
      const gamesMissed = getGamesMissedForPlayer(p, stats);
      const injuries = getInjuryInfoForPlayer(p);
      return { p, stats, weeklyHighAvg, gamesMissed, injuries };
    });

    rows.sort(compareRows);
    return rows;
  }

  function doRender() {
    const rows = buildRows();

    let html = "<table><thead><tr>";
    html += '<th data-sort-key="name">Player</th>';
    html += '<th data-sort-key="team">Team</th>';
    html += '<th data-sort-key="fpos">Fantasy Pos</th>';
    html += '<th data-sort-key="gp">GP</th>';
    html += '<th data-sort-key="gmiss">G Missed</th>';
    html += '<th data-sort-key="minPerGame">MIN</th>';
    html += '<th data-sort-key="fptsPerGame">FPTS</th>';
    html += '<th data-sort-key="weeklyHighAvg">Weekly High Avg</th>';
    html += '<th data-sort-key="ptsPerGame">PTS</th>';
    html += '<th data-sort-key="rebPerGame">REB</th>';
    html += '<th data-sort-key="astPerGame">AST</th>';
    html += '<th data-sort-key="stlPerGame">STL</th>';
    html += '<th data-sort-key="blkPerGame">BLK</th>';
    html += '<th data-sort-key="tovPerGame">TOV</th>';
    html += '<th data-sort-key="fgmPerGame">FGM</th>';
    html += '<th data-sort-key="fgaPerGame">FGA</th>';
    html += '<th data-sort-key="ftmPerGame">FTM</th>';
    html += '<th data-sort-key="ftaPerGame">FTA</th>';
    html += '<th data-sort-key="tpmPerGame">3PM</th>';
    html += "<th>Injuries</th>";
    html += "</tr></thead><tbody>";

    for (const row of rows) {
      const p = row.p;
      const s = row.stats || {};
      const gp = s.gp || 0;

      const minPerGame = gp ? s.minsTotal / gp : 0;
      const fptsPerGame = gp ? s.fptsTotal / gp : 0;
      const ptsPerGame = gp ? s.ptsTotal / gp : 0;
      const rebPerGame = gp ? s.rebTotal / gp : 0;
      const astPerGame = gp ? s.astTotal / gp : 0;
      const stlPerGame = gp ? s.stlTotal / gp : 0;
      const blkPerGame = gp ? s.blkTotal / gp : 0;
      const tovPerGame = gp ? s.tovTotal / gp : 0;
      const fgmPerGame = gp ? s.fgmTotal / gp : 0;
      const fgaPerGame = gp ? s.fgaTotal / gp : 0;
      const ftmPerGame = gp ? s.ftmTotal / gp : 0;
      const ftaPerGame = gp ? s.ftaTotal / gp : 0;
      const tpmPerGame = gp ? s.tpmTotal / gp : 0;

      html += "<tr>";
      html += `<td>${esc(p.full_name || p.sleeper_player_id)}</td>`;
      html += `<td>${esc(p.team || "")}</td>`;
      html += `<td>${esc((p.fantasy_positions || []).join(", "))}</td>`;
      html += `<td>${esc(gp || "")}</td>`;
      html += `<td>${esc(row.gamesMissed ?? "")}</td>`;
      html += `<td>${esc(minPerGame ? minPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(fptsPerGame ? fptsPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(
        row.weeklyHighAvg ? row.weeklyHighAvg.toFixed(1) : ""
      )}</td>`;
      html += `<td>${esc(ptsPerGame ? ptsPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(rebPerGame ? rebPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(astPerGame ? astPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(stlPerGame ? stlPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(blkPerGame ? blkPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(tovPerGame ? tovPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(fgmPerGame ? fgmPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(fgaPerGame ? fgaPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(ftmPerGame ? ftmPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(ftaPerGame ? ftaPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(tpmPerGame ? tpmPerGame.toFixed(1) : "")}</td>`;
      html += `<td>${esc(row.injuries)}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;

    // Attach sort handlers after table is rendered
    const headers = container.querySelectorAll("th[data-sort-key]");
    headers.forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort-key");
        if (!key) return;

        if (currentSortKey === key) {
          currentSortDir = -currentSortDir; // toggle asc/desc
        } else {
          currentSortKey = key;
          currentSortDir = key === "name" ? 1 : -1; // names asc, numbers desc
        }

        doRender();
      });
    });
  }

  filterInput.addEventListener("input", doRender);
  posSelect.addEventListener("change", doRender);

  // Let ESPN injuries trigger a refresh when they load
  window.renderFreeAgentsTableRefresh = doRender;

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
    const injuriesIndex = new Map(); // normName(player) -> [injuries]

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
        const returnDate =
          details.returnDate ||
          details.returnDateText ||
          details.return_date ||
          "";
        const started =
          details.injuryDate ||
          details.statusDate ||
          details.date ||
          details.injuryDateText ||
          "";

        const record = {
          player: injury.athlete?.displayName || "N/A",
          team: teamAbbr,
          status,
          type: type || "",
          detail,
          returnDate,
          started,
        };

        injuries.push(record);

        const key = normName(record.player);
        if (!injuriesIndex.has(key)) {
          injuriesIndex.set(key, []);
        }
        injuriesIndex.get(key).push(record);
      }
    }

    gInjuriesByNormName = injuriesIndex;

    if (!injuries.length) {
      container.textContent = "No injuries reported.";
    } else {
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
        html += `<td>${esc(inj.started || "")}</td>`;
        html += `<td>${esc(inj.returnDate || "")}</td>`;
        html += "</tr>";
      }

      html += "</tbody></table>";
      container.innerHTML = html;
    }

    // Re-render FA table so the injury column populates
    if (typeof window.renderFreeAgentsTableRefresh === "function") {
      window.renderFreeAgentsTableRefresh();
    }
  } catch (err) {
    console.error("Error fetching live injuries:", err);
    container.textContent =
      "Could not load live injuries. ESPN may be blocking cross-origin requests; later we can add a backend proxy if needed.";
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

  // Normalize the bundle so nba.seasons + current_season
  // are always present, even if backend only wrote player_gamelogs.
  bundle = normalizeBundle(bundle);

  // Compute season aggregates used by the Free Agents tab
  computeSeasonAggregatesForCurrentSeason(bundle);

  const leagueName = bundle.sleeper?.league?.name || "";
  renderMeta(bundle.meta, leagueName);
  renderOverviewPlayers(bundle);
  renderRostersTable(bundle);
  renderFreeAgentsTable(bundle);
  setupGameLogs(bundle);
  renderTransactions(bundle);

  // Live injuries are always pulled fresh and also enrich FA injuries column
  fetchLiveInjuries();
}

init();
