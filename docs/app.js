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
  // Map of normalized player name -> season aggregates for current season
let gSeasonAggByNormName = null;
// Map of normalized player name -> latest ESPN injury info
let gInjuriesByNormName = null;

/**
 * Compute per-player season aggregates for the current season:
 * - GP, per-game MIN / PTS / REB / AST / STL / BLK / TOV / FGM / FGA / FTM / FTA / 3PM
 * - FPTS per game (Sleeper scoring)
 * - Games missed (based on team games played)
 * - Weekly "lock-in" high average (avg weekly max game per Monday–Sunday week)
 */
function computeSeasonAggregatesForCurrentSeason(bundle) {
  const currentSeason = bundle.meta.current_season;
  const seasonBlock = bundle.nba?.seasons?.[currentSeason];
  if (!seasonBlock || !Array.isArray(seasonBlock.game_logs)) {
    console.warn("computeSeasonAggregatesForCurrentSeason: no game_logs for current season", currentSeason);
    return new Map();
  }

  const logs = seasonBlock.game_logs;

  // For games-missed: track distinct game dates per team
  const teamDateSets = new Map(); // team -> Set(dateStr)

  // Per-player accumulation by normalized name
  const byPlayer = new Map(); // normName -> record

  function getLockInWeekKey(dateObj) {
    // Use UTC and group Monday–Sunday, with Monday as the start.
    const d = new Date(Date.UTC(
      dateObj.getUTCFullYear(),
      dateObj.getUTCMonth(),
      dateObj.getUTCDate()
    ));
    const dow = d.getUTCDay(); // 0=Sun,1=Mon,...,6=Sat
    const offsetToMonday = (dow + 6) % 7; // Mon -> 0, Sun -> 6
    d.setUTCDate(d.getUTCDate() - offsetToMonday);
    return d.toISOString().slice(0, 10);
  }

  for (const g of logs) {
    const rawName = g.PLAYER_NAME || g.player_name || "";
    const nName = normName(rawName);
    if (!nName) continue;

    const team = g.TEAM_ABBREVIATION || g.TEAM_ABBR || g.TEAM || "";
    const dateStr = g.GAME_DATE || g.GAME_DATE_EST || g.game_date || "";
    let d = null;
    if (dateStr) {
      const tmp = new Date(dateStr);
      if (!isNaN(tmp)) d = tmp;
    }

    const min = Number(g.MIN) || 0;
    const pts = Number(g.PTS) || 0;
    const reb = Number(g.REB ?? g.TREB ?? g.REB_TOTAL ?? 0) || 0;
    const ast = Number(g.AST) || 0;
    const stl = Number(g.STL) || 0;
    const blk = Number(g.BLK ?? g.BLOCKS ?? 0) || 0;
    const tov = Number(g.TOV ?? g.TO ?? 0) || 0;
    const fgm = Number(g.FGM ?? g.FG ?? 0) || 0;
    const fga = Number(g.FGA ?? g.FGA_ATTEMPTED ?? 0) || 0;
    const ftm = Number(g.FTM ?? 0) || 0;
    const fta = Number(g.FTA ?? 0) || 0;
    const tpm = Number(g.FG3M ?? g["3PM"] ?? 0) || 0;

    // Sleeper scoring for a single game:
    const fptsGame =
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
      tpm * 1;

    let rec = byPlayer.get(nName);
    if (!rec) {
      rec = {
        name: rawName,
        team: team,
        gp: 0,
        min: 0,
        pts: 0,
        reb: 0,
        ast: 0,
        stl: 0,
        blk: 0,
        tov: 0,
        fgm: 0,
        fga: 0,
        ftm: 0,
        fta: 0,
        tpm: 0,
        fptsSum: 0,
        weeklyHighs: new Map(), // weekKey -> max FPTS for that week
      };
      byPlayer.set(nName, rec);
    }

    rec.gp += 1;
    rec.min += min;
    rec.pts += pts;
    rec.reb += reb;
    rec.ast += ast;
    rec.stl += stl;
    rec.blk += blk;
    rec.tov += tov;
    rec.fgm += fgm;
    rec.fga += fga;
    rec.ftm += ftm;
    rec.fta += fta;
    rec.tpm += tpm;
    rec.fptsSum += fptsGame;

    if (team) rec.team = team;

    // Weekly lock-in stat
    if (d) {
      const weekKey = getLockInWeekKey(d);
      const prev = rec.weeklyHighs.get(weekKey);
      if (prev == null || fptsGame > prev) {
        rec.weeklyHighs.set(weekKey, fptsGame);
      }

      // Track team games played (distinct dates)
      if (team) {
        let set = teamDateSets.get(team);
        if (!set) {
          set = new Set();
          teamDateSets.set(team, set);
        }
        set.add(dateStr);
      }
    }
  }

  const result = new Map();

  for (const [nName, rec] of byPlayer.entries()) {
    const team = rec.team || "";
    const teamDatesSet = team ? teamDateSets.get(team) : null;
    const teamGames = teamDatesSet ? teamDatesSet.size : null;

    const weeklyValues = Array.from(rec.weeklyHighs.values());
    const weeklyHighAvg = weeklyValues.length
      ? weeklyValues.reduce((a, b) => a + b, 0) / weeklyValues.length
      : null;

    const gp = rec.gp || 0;
    const per = (val) => (gp > 0 ? +(val / gp).toFixed(1) : 0);

    const gamesMissed = teamGames != null ? Math.max(teamGames - gp, 0) : null;

    result.set(nName, {
      name: rec.name,
      team,
      gp,
      minPerGame: per(rec.min),
      ptsPerGame: per(rec.pts),
      rebPerGame: per(rec.reb),
      astPerGame: per(rec.ast),
      stlPerGame: per(rec.stl),
      blkPerGame: per(rec.blk),
      tovPerGame: per(rec.tov),
      fgmPerGame: per(rec.fgm),
      fgaPerGame: per(rec.fga),
      ftmPerGame: per(rec.ftm),
      ftaPerGame: per(rec.fta),
      tpmPerGame: per(rec.tpm),
      fptsPerGame: gp > 0 ? +(rec.fptsSum / gp).toFixed(1) : 0,
      weeklyHighAvg: weeklyHighAvg != null ? +weeklyHighAvg.toFixed(1) : null,
      gamesMissed: gamesMissed != null ? gamesMissed : null,
    });
  }

  return result;
}

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

function renderFreeAgentsTable(bundle, seasonAggByNormName) {
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
    Array.isArray(seasonBlock.season_stats) &&
    seasonBlock.season_stats.length > 0;

  // Which players are already owned in the league
  const owned = new Set();
  for (const r of rostersPlayers) {
    if (r.sleeper_player_id != null) {
      owned.add(String(r.sleeper_player_id));
    }
  }

  // Base candidate FAs: unowned, on a team, active, NOT two-way/ten-day
  let candidateFA;

  function isDisplayableStatus(status) {
    if (!status) return false;
    if (status === "ACT") return true;
    // Explicitly exclude two-way / ten-day
    if (status === "TWO-WAY" || status === "TEN-DAY") return false;
    return false;
  }

  if (hasSeasonStats) {
    const stats = seasonBlock.season_stats;
    const statsNameSet = new Set(stats.map((s) => normName(s.PLAYER_NAME)));

    candidateFA = players.filter((p) => {
      const id = String(p.sleeper_player_id || "");
      if (!id || owned.has(id)) return false;
      if (!p.team) return false;
      if (p.active === false) return false;
      if (!isDisplayableStatus(p.status)) return false;

      const nm = normName(p.full_name);
      if (!statsNameSet.has(nm)) return false;

      return true;
    });
  } else {
    // Fallback: no NBA stats available – use Sleeper only
    candidateFA = players.filter((p) => {
      const id = String(p.sleeper_player_id || "");
      if (!id || owned.has(id)) return false;
      if (!p.team) return false; // must be on an NBA team
      if (p.status === "RET") return false;
      if (p.active === false) return false;
      if (!isDisplayableStatus(p.status)) return false;
      return true;
    });
  }

  const filterInput = document.getElementById("fa-player-filter");
  const posSelect = document.getElementById("fa-pos-filter");

  let currentSortKey = "fptsPerGame";
  let currentSortDir = -1; // -1 = desc, 1 = asc

  function getInjuryForPlayer(normName) {
    if (!gInjuriesByNormName) return null;
    return gInjuriesByNormName.get(normName) || null;
  }

  function doRender() {
    const nameFilter = (filterInput.value || "").toLowerCase();
    const posFilter = posSelect.value || "";

    // Build row objects: { p, stats, inj }
    let rows = candidateFA.filter((p) => {
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
    }).map((p) => {
      const nName = normName(p.full_name);
      const stats = seasonAggByNormName
        ? seasonAggByNormName.get(nName) || {}
        : {};
      const inj = getInjuryForPlayer(nName);
      return { p, stats, inj };
    });

    function getSortValue(row) {
      const stats = row.stats || {};
      switch (currentSortKey) {
        case "name":
          return (row.p.full_name || "").toLowerCase();
        case "team":
          return (row.p.team || "").toLowerCase();
        case "fpos":
          return (row.p.fantasy_positions || []).join(",").toLowerCase();
        case "fptsPerGame":
          return stats.fptsPerGame ?? 0;
        case "minPerGame":
          return stats.minPerGame ?? 0;
        case "ptsPerGame":
          return stats.ptsPerGame ?? 0;
        case "rebPerGame":
          return stats.rebPerGame ?? 0;
        case "astPerGame":
          return stats.astPerGame ?? 0;
        case "stlPerGame":
          return stats.stlPerGame ?? 0;
        case "blkPerGame":
          return stats.blkPerGame ?? 0;
        case "tovPerGame":
          return stats.tovPerGame ?? 0;
        case "fgmPerGame":
          return stats.fgmPerGame ?? 0;
        case "fgaPerGame":
          return stats.fgaPerGame ?? 0;
        case "ftmPerGame":
          return stats.ftmPerGame ?? 0;
        case "ftaPerGame":
          return stats.ftaPerGame ?? 0;
        case "tpmPerGame":
          return stats.tpmPerGame ?? 0;
        case "gamesMissed":
          return stats.gamesMissed ?? 0;
        case "weeklyHighAvg":
          return stats.weeklyHighAvg ?? 0;
        default:
          return 0;
      }
    }

    rows.sort((a, b) => {
      const av = getSortValue(a);
      const bv = getSortValue(b);
      if (typeof av === "string" || typeof bv === "string") {
        return currentSortDir * String(av).localeCompare(String(bv));
      }
      return currentSortDir * (av - bv);
    });

    let html = "<table><thead><tr>";
    html += '<th data-sort-key="name">Player</th>';
    html += '<th data-sort-key="team">Team</th>';
    html += '<th data-sort-key="fpos">Fantasy Pos</th>';
    html += "<th>Injury</th>";
    html += "<th>Inj Since</th>";
    html += '<th data-sort-key="gp">GP</th>';
    html += '<th data-sort-key="minPerGame">MIN</th>';
    html += '<th data-sort-key="fptsPerGame">FPTS</th>';
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
    html += '<th data-sort-key="gamesMissed">G Missed</th>';
    html += '<th data-sort-key="weeklyHighAvg">Weekly High Avg</th>';
    html += "</tr></thead><tbody>";

    for (const row of rows) {
      const p = row.p;
      const s = row.stats || {};
      const inj = row.inj;

      const fpos = (p.fantasy_positions || []).join(", ");
      let injSummary = "";
      let injSince = "";

      if (inj) {
        injSummary = [
          inj.status || "",
          inj.type || "",
          inj.detail || "",
        ]
          .filter(Boolean)
          .join(" — ");

        if (inj.startDate) {
          injSince = inj.startDate;
        }
      }

      html += "<tr>";
      html += `<td>${esc(p.full_name || p.sleeper_player_id)}</td>`;
      html += `<td>${esc(p.team || "")}</td>`;
      html += `<td>${esc(fpos)}</td>`;
      html += `<td>${esc(injSummary)}</td>`;
      html += `<td>${esc(injSince)}</td>`;
      html += `<td>${esc(s.gp ?? "")}</td>`;
      html += `<td>${esc(s.minPerGame ?? "")}</td>`;
      html += `<td>${esc(s.fptsPerGame ?? "")}</td>`;
      html += `<td>${esc(s.ptsPerGame ?? "")}</td>`;
      html += `<td>${esc(s.rebPerGame ?? "")}</td>`;
      html += `<td>${esc(s.astPerGame ?? "")}</td>`;
      html += `<td>${esc(s.stlPerGame ?? "")}</td>`;
      html += `<td>${esc(s.blkPerGame ?? "")}</td>`;
      html += `<td>${esc(s.tovPerGame ?? "")}</td>`;
      html += `<td>${esc(s.fgmPerGame ?? "")}</td>`;
      html += `<td>${esc(s.fgaPerGame ?? "")}</td>`;
      html += `<td>${esc(s.ftmPerGame ?? "")}</td>`;
      html += `<td>${esc(s.ftaPerGame ?? "")}</td>`;
      html += `<td>${esc(s.tpmPerGame ?? "")}</td>`;
      html += `<td>${esc(s.gamesMissed ?? "")}</td>`;
      html += `<td>${esc(s.weeklyHighAvg ?? "")}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;

    // Attach sort handlers after table is rendered
    const headers = container.querySelectorAll("th[data-sort-key]");
    headers.forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sortKey;
        if (!key) return;
        if (currentSortKey === key) {
          currentSortDir = -currentSortDir; // toggle
        } else {
          currentSortKey = key;
          currentSortDir = key === "name" ? 1 : -1;
        }
        doRender();
      });
    });
  }

  // Expose a global refresh so injuries can re-render when ESPN data arrives
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
    const injuriesByNorm = new Map();

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

        // Try to infer a "start date" for the injury from any available field
        let startDate =
          injury.date ||
          injury.statusDate ||
          details.date ||
          details.injuryDate ||
          details.startDate ||
          details.injuryStartDate ||
          "";

        if (startDate && typeof startDate === "string") {
          // Normalize to YYYY-MM-DD if possible
          startDate = startDate.slice(0, 10);
        }

        const record = {
          player: injury.athlete?.displayName || "N/A",
          team: teamAbbr,
          status,
          type: type || "",
          detail,
          returnDate,
          startDate,
        };

        injuries.push(record);

        const nName = normName(record.player);
        if (nName) {
          injuriesByNorm.set(nName, record);
        }
      }
    }

    gInjuriesByNormName = injuriesByNorm;

    if (!injuries.length) {
      container.textContent = "No injuries reported.";
      // Still refresh Free Agents to clear any old injuries
      if (window.renderFreeAgentsTableRefresh) {
        window.renderFreeAgentsTableRefresh();
      }
      return;
    }

    injuries.sort((a, b) => {
      const t = a.team.localeCompare(b.team);
      if (t !== 0) return t;
      return a.player.localeCompare(b.player);
    });

    let html = "<table><thead><tr>";
    html +=
      "<th>Player</th><th>Team</th><th>Status</th><th>Injury</th><th>Detail</th><th>Return</th><th>Since</th>";
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
      html += `<td>${esc(inj.startDate || "")}</td>`;
      html += "</tr>";
    }

    html += "</tbody></table>";
    container.innerHTML = html;

    // Refresh Free Agents so the injuries column updates with this new data
    if (window.renderFreeAgentsTableRefresh) {
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

  // 🔧 Normalize the bundle so nba.seasons + current_season
  // are always present, even if backend only wrote player_gamelogs.
  bundle = normalizeBundle(bundle);

  // Build per-player season aggregates for the current season
  gSeasonAggByNormName = computeSeasonAggregatesForCurrentSeason(bundle);

  const leagueName = bundle.sleeper?.league?.name || "";
  renderMeta(bundle.meta, leagueName);
  renderOverviewPlayers(bundle);
  renderRostersTable(bundle);
  renderFreeAgentsTable(bundle, gSeasonAggByNormName);
  setupGameLogs(bundle);
  renderTransactions(bundle);

  // Live injuries are always pulled fresh
  fetchLiveInjuries();
}

init();


