import { useState, useCallback, useRef, useEffect } from "react";

// ============================================================
// ROOT CAUSE: CORS
// The artifact iframe cannot call v2.api.imprint.gg directly.
// The API does not send CORS headers, so browser fetch() fails
// with "Failed to fetch" from sandboxed iframes.
//
// FIX: smartImprintGet() first tries a direct fetch. If it
// gets a CORS/NetworkError, it automatically falls back to
// routing the request through the Claude API (claude-proxy
// mode), where Claude fetches the URL server-side via web_search
// and returns the raw JSON in its text response. No CORS issue.
// ============================================================

const IMPRINT_BASE = "https://v2.api.imprint.gg";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const LIQUID_API_KEY = "vG1LUFaoBC1pfpotkonHDazfbh47padu1sVrMzKB";
const DEFAULT_SEASON = "2025-2026";

// Fetch an Imprint endpoint via Claude (server-side, bypasses CORS)
async function imprintGetViaClaude(path, apiKey) {
  const url = `${IMPRINT_BASE}${path}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system: `You are a data relay. Fetch the given URL using web_search and return ONLY the raw JSON body — no commentary, no markdown fences, no explanation. The request requires header x-api-key: ${apiKey}`,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: `Fetch and return only the raw JSON from: ${url}` }],
    }),
  });
  const data = await res.json();
  const text = data.content?.filter((b) => b.type === "text").map((b) => b.text).join("") || "";
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  if (!clean) throw new Error(`Empty response from Claude proxy for ${path}`);
  try {
    return JSON.parse(clean);
  } catch {
    throw new Error(`Claude proxy returned non-JSON for ${path}: ${clean.slice(0, 300)}`);
  }
}

// Smart fetch: tries direct, auto-falls back to Claude proxy on CORS
async function smartFetch(path, apiKey, useProxy = false) {
  if (useProxy) return imprintGetViaClaude(path, apiKey);
  try {
    const res = await fetch(`${IMPRINT_BASE}${path}`, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res.json();
  } catch (e) {
    const isCors =
      e.message.includes("Failed to fetch") ||
      e.message.includes("NetworkError") ||
      e.message.includes("CORS") ||
      e.name === "TypeError";
    if (isCors) {
      // Auto-upgrade to proxy and retry
      return imprintGetViaClaude(path, apiKey);
    }
    throw e;
  }
}

// ============================================================
// CONTEXT STORE
// ============================================================
const createStore = () => ({
  apiKey: null,
  seasonTag: DEFAULT_SEASON,
  teams: {},
  playerHeroStats: {},
  teamHeroStats: {},
  leagueHeroStats: {},
  seasonHeroMeta: {},
  seasonTeams: {},
  leagues: {},
  fetched: new Set(),
  proxy: false,
  last_updated: null,
});

// ============================================================
// DATA FETCHERS
// ============================================================

async function fetchLeagueRoster(leagueId, apiKey, store) {
  const ck = `lr_${leagueId}`;
  if (store.fetched.has(ck)) return;
  const [td, pd] = await Promise.all([
    smartFetch(`/league/${leagueId}/teams`, apiKey, store.proxy),
    smartFetch(`/league/${leagueId}/players`, apiKey, store.proxy),
  ]);
  const teams = Array.isArray(td) ? td : td.teams || [];
  teams.forEach((t) => {
    const k = t.team_name.toLowerCase();
    if (!store.teams[k]) store.teams[k] = { ...t, players: [], league_ids: [] };
    if (!store.teams[k].league_ids.includes(leagueId)) store.teams[k].league_ids.push(leagueId);
  });
  const players = Array.isArray(pd) ? pd : pd.players || [];
  players.forEach((p) => {
    const tk = p.team?.team_name?.toLowerCase();
    if (tk && store.teams[tk] && !store.teams[tk].players.find((x) => x.account_id === p.account_id))
      store.teams[tk].players.push(p);
  });
  store.leagues[leagueId] = {
    league_name: (Array.isArray(td) ? "" : td.league_name) || `League ${leagueId}`,
    team_ids: teams.map((t) => t.team_id),
    fetched_at: Date.now(),
  };
  store.fetched.add(ck);
}

async function fetchTeamHeroStats(teamId, leagueId, apiKey, store) {
  const ck = `th_${teamId}_${leagueId}`;
  if (store.fetched.has(ck)) return;
  const d = await smartFetch(`/league/${leagueId}/team/${teamId}/heroes`, apiKey, store.proxy);
  if (!store.teamHeroStats[teamId]) store.teamHeroStats[teamId] = {};
  store.teamHeroStats[teamId][leagueId] = d.hero_statistics?.heroes || [];
  store.fetched.add(ck);
}

async function fetchPlayerHeroStats(accountId, leagueId, apiKey, store) {
  const ck = `ph_${accountId}_${leagueId}`;
  if (store.fetched.has(ck)) return;
  const d = await smartFetch(`/league/${leagueId}/player/${accountId}/heroes`, apiKey, store.proxy);
  if (!store.playerHeroStats[accountId]) store.playerHeroStats[accountId] = {};
  store.playerHeroStats[accountId][leagueId] = d.hero_statistics?.heroes || [];
  store.fetched.add(ck);
}

async function fetchLeagueHeroStats(leagueId, apiKey, store) {
  const ck = `lh_${leagueId}`;
  if (store.fetched.has(ck)) return;
  const d = await smartFetch(`/league/${leagueId}/heroes`, apiKey, store.proxy);
  store.leagueHeroStats[leagueId] = d.hero_statistics?.heroes || [];
  store.fetched.add(ck);
}

async function fetchSeasonHeroMeta(seasonTag, apiKey, store) {
  const ck = `sm_${seasonTag}`;
  if (store.fetched.has(ck)) return;
  const d = await smartFetch(`/season/${seasonTag}/rankings/heroes`, apiKey, store.proxy);
  store.seasonHeroMeta[seasonTag] = Array.isArray(d) ? d : [];
  store.fetched.add(ck);
}

async function probeConnectivity(apiKey, seasonTag, store, log) {
  log("Probing Imprint API connectivity...");
  try {
    await fetch(`${IMPRINT_BASE}/season/${seasonTag}/leagues`, {
      headers: { "x-api-key": apiKey },
    });
    log("Direct API access OK.");
    store.proxy = false;
  } catch (e) {
    log("Direct access blocked (CORS). Auto-enabling Claude-proxy mode.");
    store.proxy = true;
  }
}

async function discoverLiquidLeagues(seasonTag, apiKey, store, log) {
  log("Fetching season leagues...");
  const seasonLeagues = await smartFetch(`/season/${seasonTag}/leagues`, apiKey, store.proxy);
  log(`${seasonLeagues.length} leagues in season ${seasonTag}`);

  if (!store.seasonTeams[seasonTag]) {
    log("Fetching season teams...");
    store.seasonTeams[seasonTag] = await smartFetch(`/season/${seasonTag}/teams`, apiKey, store.proxy);
  }
  const liquid = store.seasonTeams[seasonTag].find((t) =>
    t.team_name.toLowerCase().includes("liquid")
  );
  if (!liquid) throw new Error("Team Liquid not found in season " + seasonTag);
  log(`Found: ${liquid.team_name} (id: ${liquid.team_id})`);

  const completed = seasonLeagues.filter(
    (l) => !l.status || l.status === "completed" || l.status === "uncompleted"
  );
  const found = [];
  log(`Scanning up to 25 leagues for Liquid participation...`);
  for (const league of completed.slice(0, 25)) {
    try {
      await fetchLeagueRoster(league.league_id, apiKey, store);
      const lk = liquid.team_name.toLowerCase();
      if (store.teams[lk]?.league_ids?.includes(league.league_id)) {
        const lname = store.leagues[league.league_id]?.league_name || `League ${league.league_id}`;
        found.push({ ...league, league_name: lname });
        log(`  ✓ ${lname} (#${league.league_id})`);
      }
    } catch (e) {
      log(`  Skip ${league.league_id}: ${e.message}`);
    }
    if (found.length >= 3) break;
  }
  if (!found.length) throw new Error("No Team Liquid leagues found");
  store.last_updated = new Date().toISOString();
  return { liquid, leagues: found.slice(0, 3) };
}

async function hydrateTeam(teamName, seasonTag, apiKey, store, log) {
  log(`Resolving: ${teamName}`);
  if (!store.seasonTeams[seasonTag]) {
    store.seasonTeams[seasonTag] = await smartFetch(`/season/${seasonTag}/teams`, apiKey, store.proxy);
  }
  const k = teamName.toLowerCase().trim();
  const match = store.seasonTeams[seasonTag].find(
    (t) => t.team_name.toLowerCase() === k || t.team_name.toLowerCase().includes(k) || k.includes(t.team_name.toLowerCase())
  );
  if (!match) throw new Error(`Team "${teamName}" not found`);

  const slKey = seasonTag + "_leagues";
  if (!store.seasonTeams[slKey]) {
    store.seasonTeams[slKey] = await smartFetch(`/season/${seasonTag}/leagues`, apiKey, store.proxy);
  }
  const recent = store.seasonTeams[slKey]
    .filter((l) => !l.status || l.status === "completed" || l.status === "uncompleted")
    .slice(0, 20);

  for (const league of recent) {
    await fetchLeagueRoster(league.league_id, apiKey, store).catch(() => {});
  }
  const teamKey = match.team_name.toLowerCase();
  const entry = store.teams[teamKey];
  if (!entry) throw new Error(`Cannot find "${teamName}" in rosters`);

  const lids = entry.league_ids.length > 0 ? entry.league_ids : recent.map((l) => l.league_id).slice(0, 3);
  log(`Hero stats for ${entry.team_name} across ${lids.length} league(s)`);
  await Promise.all(
    lids.flatMap((lid) => [
      fetchTeamHeroStats(entry.team_id, lid, apiKey, store).catch(() => {}),
      fetchLeagueHeroStats(lid, apiKey, store).catch(() => {}),
      ...entry.players.map((p) => fetchPlayerHeroStats(p.account_id, lid, apiKey, store).catch(() => {})),
    ])
  );
  log(`${entry.team_name} hydrated (${entry.players.length} players)`);
  return entry;
}

// ============================================================
// CONTEXT PACKET BUILDER
// ============================================================

function buildWHS(heroName, teamId, accountIds, leagueIds, store, seasonTag) {
  const ts = [], ps = {};
  leagueIds.forEach((lid) => {
    const th = store.teamHeroStats[teamId]?.[lid] || [];
    const he = th.find((h) => h.name === heroName || h.raw_name === heroName);
    if (he) ts.push({ ...he, lid });
    accountIds.forEach((aid) => {
      const ph = store.playerHeroStats[aid]?.[lid] || [];
      const pe = ph.find((h) => h.name === heroName || h.raw_name === heroName);
      if (pe) { if (!ps[aid]) ps[aid] = []; ps[aid].push({ ...pe, lid }); }
    });
  });
  const wwr = (s) => {
    if (!s.length) return null;
    const tot = s.reduce((a, x) => a + (x.match_count || 0), 0);
    if (!tot) return null;
    return { wr: s.reduce((a, x) => a + parseFloat(x.win_rate || "0") * (x.match_count || 0), 0) / tot, games: tot };
  };
  const meta = (store.seasonHeroMeta[seasonTag] || []).find((h) => h.name === heroName);
  const mWR = meta ? parseFloat(meta.win_rate || "0") : 50;
  const mPR = meta ? (meta.match_count / Math.max(1, (store.seasonHeroMeta[seasonTag] || []).reduce((a, h) => a + h.match_count, 0))) * 100 : 0;
  const tw = wwr(ts);
  const tg = ts.reduce((a, x) => a + (x.match_count || 0), 0);
  return {
    hero: heroName, team_games: tg, team_win_rate: tw?.wr ?? null,
    meta_win_rate: mWR, meta_pick_rate_pct: mPR,
    win_rate_delta: tw ? tw.wr - mWR : null,
    confidence: tg >= 10 ? "HIGH" : tg >= 5 ? "MEDIUM" : "LOW",
    player_breakdown: Object.entries(ps).map(([aid, samps]) => {
      const pw = wwr(samps);
      return { account_id: parseInt(aid), games: samps.reduce((a, x) => a + x.match_count, 0), win_rate: pw?.wr ?? null, win_rate_delta: pw ? pw.wr - mWR : null };
    }),
  };
}

function buildContextPacket(ourName, oppName, radiant, firstPick, store, seasonTag, liquidLeagues) {
  const ourE = store.teams[ourName.toLowerCase()];
  const oppE = store.teams[oppName.toLowerCase()];
  if (!ourE || !oppE) throw new Error("Teams not hydrated");

  const buildProfile = (e) => {
    const lids = e.league_ids;
    const aids = e.players.map((p) => p.account_id);
    const totalM = lids.reduce((s, l) => s + (store.leagues[l]?.match_count || 10), 0);
    const allH = new Set();
    lids.forEach((l) => (store.teamHeroStats[e.team_id]?.[l] || []).forEach((h) => allH.add(h.name)));
    const classified = [...allH]
      .map((n) => buildWHS(n, e.team_id, aids, lids, store, seasonTag))
      .map((h) => {
        const prr = h.meta_pick_rate_pct > 0 ? (h.team_games / Math.max(1, totalM)) / (h.meta_pick_rate_pct / 100) : 0;
        let cls = "situational";
        if (prr >= 1.5 && h.win_rate_delta !== null && h.win_rate_delta >= 5) cls = "core_identity";
        else if (prr >= 1.5 && (h.win_rate_delta === null || h.win_rate_delta < 0)) cls = "habit_pick";
        else if (h.win_rate_delta !== null && h.win_rate_delta >= 5) cls = "comfort_pick";
        else if (h.win_rate_delta !== null && h.win_rate_delta <= -5) cls = "risk_pick";
        return { ...h, pick_rate_ratio: prr, classification: cls };
      })
      .sort((a, b) => b.team_games - a.team_games);
    return {
      team_id: e.team_id, team_name: e.team_name, league_ids: lids,
      players: e.players.map((p) => ({ account_id: p.account_id, account_name: p.account_name, position: p.position, win_rate: p.win_rate, match_count: p.match_count, average_imprint_rating: p.average_imprint_rating })),
      hero_pool: classified,
      top_identity_heroes: classified.filter((h) => h.classification === "core_identity").slice(0, 5),
      comfort_picks: classified.filter((h) => h.classification === "comfort_pick").slice(0, 8),
      habit_picks: classified.filter((h) => h.classification === "habit_pick"),
      risk_picks: classified.filter((h) => h.classification === "risk_pick"),
    };
  };

  return {
    simulation_id: `${ourName}_vs_${oppName}_${Date.now()}`,
    our_team: ourName, opposition_team: oppName,
    radiant_team: radiant, first_pick_team: firstPick,
    season_tag: seasonTag,
    our_profile: buildProfile(ourE),
    opp_profile: buildProfile(oppE),
    meta_baseline: (store.seasonHeroMeta[seasonTag] || []).slice(0, 30),
    generated_at: new Date().toISOString(),
    data_source: `Imprint GG v2 API — last ${liquidLeagues.length} Team Liquid tournaments: ${liquidLeagues.map((l) => l.league_name).join(", ")}`,
    draft_format: "action_number 1-24 | FIRST_BAN(1-6), FIRST_PICK(7-12), SECOND_BAN(13-16), SECOND_PICK(17-20), THIRD_BAN(21-22), THIRD_PICK(23-24) | Radiant acts first in odd phases",
    liquid_leagues: liquidLeagues,
  };
}

// ============================================================
// AGENTS
// ============================================================

async function callAgent(system, user, webSearch = false) {
  const body = { model: CLAUDE_MODEL, max_tokens: 1000, system, messages: [{ role: "user", content: user }] };
  if (webSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  return d.content.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
}

const SYS = {
  lead: `You are the lead Dota 2 draft strategist FOR our team. Data from Imprint GG v2 API. Do NOT re-request data.
1. Review all sub-agent outputs.
2. Recommend all 24 pick/ban slots: slot_number | pick/ban | hero | decided_by | reasoning | confidence HIGH/MEDIUM/LOW
3. LOW-confidence slots: ESCALATE_TO_B: <slot>: <candidates_csv>: <reason>
4. 3-5 sentence strategy summary + win conditions.
Draft format: 1-24. FIRST_BAN(1-6), FIRST_PICK(7-12), SECOND_BAN(13-16), SECOND_PICK(17-20), THIRD_BAN(21-22), THIRD_PICK(23-24). Radiant first in odd phases.`,
  a: `Dota 2 draft order specialist — sequencing only.
1. Pick/ban priority: first/second pick, radiant/dire, identity heroes to deny/secure.
2. For each of 24 slots: offensive or defensive, top hero targets.
3. Tempo-critical phases.
4. Priority ban list (top 5) and pick list (top 5) with one-line reasoning.`,
  b: `Dota 2 team comfort analyst — OUR TEAM ONLY.
1. Core identity heroes (high pick rate + strong WR + ban pressure against us).
2. Comfort picks (personal WR > meta by 5%+) per player/position.
3. Habit picks (high pick rate, below-meta WR).
4. Risk picks (below-meta personal WR).
5. Tier list: Tier 1 / Tier 2 / Tier 3.
For ESCALATION: TIEBREAK_DECISION: <hero>: <reason>`,
  c: `Dota 2 opposition counter-pick analyst — OPPOSITION ONLY.
1. Opposition core identity heroes — must bans.
2. Our heroes that counter opposition playstyle.
3. Opposition heroes with high ban pressure.
4. Hard-counters to our potential picks.
5. Top 5 must-ban targets | top 5 counter-picks for us | top 3 to avoid.`,
  d: `Dota 2 meta analyst with web search.
1. Search current patch meta, compare our picks against it.
2. Pro vs pub gap for key heroes.
3. Tendency signals from data: core_identity, habit, situational.
4. Confidence: HIGH (10+ games) / MEDIUM (5-9) / LOW (<5).
5. 3 key meta observations for this matchup.`,
};

async function runAgents(packet, log) {
  const ps = JSON.stringify(packet, null, 2);
  log("Agents A/B/C/D running in parallel...");
  const [aOut, bOut, cOut, dOut] = await Promise.all([
    callAgent(SYS.a, `Context packet:\n${ps}`).catch((e) => `Agent A error: ${e.message}`),
    callAgent(SYS.b, `Context packet:\n${ps}`).catch((e) => `Agent B error: ${e.message}`),
    callAgent(SYS.c, `Context packet:\n${ps}`).catch((e) => `Agent C error: ${e.message}`),
    callAgent(SYS.d, `Context packet:\n${ps}`, true).catch((e) => `Agent D error: ${e.message}`),
  ]);
  log("Lead synthesis...");
  const leadIn = `Context packet:\n${ps}\n\n--- AGENT A ---\n${aOut}\n\n--- AGENT B ---\n${bOut}\n\n--- AGENT C ---\n${cOut}\n\n--- AGENT D ---\n${dOut}`;
  const leadOut = await callAgent(SYS.lead, leadIn).catch((e) => `Lead error: ${e.message}`);
  const escalations = [];
  const er = /ESCALATE_TO_B:\s*(\d+):\s*([^:]+):\s*(.+)/g;
  let m;
  while ((m = er.exec(leadOut)) !== null) escalations.push({ slot: m[1], candidates: m[2].trim(), reason: m[3].trim() });
  let finalOut = leadOut;
  if (escalations.length > 0) {
    log(`${escalations.length} escalation(s) → Agent B...`);
    const escIn = `Context:\n${ps}\n\nEscalations:\n${escalations.map((e, i) => `${i + 1}. slot:${e.slot} candidates:${e.candidates} conflict:${e.reason}`).join("\n")}`;
    const bt = await callAgent(SYS.b, escIn).catch((e) => `B tiebreak error: ${e.message}`);
    finalOut += `\n\n--- AGENT B TIEBREAK ---\n${bt}`;
    log("Tiebreaks resolved.");
  }
  return { agentA: aOut, agentB: bOut, agentC: cOut, agentD: dOut, lead: finalOut, escalations };
}

// ============================================================
// UI
// ============================================================

const C = {
  bg: "#080b10", surf: "#0d1117", border: "#1a2535",
  accent: "#00e5ff", green: "#00ff88", text: "#c8d6e5",
  muted: "#546e7a", dim: "#37474f",
  radiant: "#4dd0e1", dire: "#ef5350",
  HIGH: "#00e676", MED: "#ffca28", LOW: "#ff7043",
  core: "#b39ddb", comfort: "#4dd0e1", habit: "#ffb74d", risk: "#ef5350",
  liq: "#0099ff",
};

const Chip = ({ cls, children }) => (
  <span style={{ display: "inline-flex", alignItems: "center", padding: "2px 7px", borderRadius: "3px", fontSize: "11px", margin: "2px 2px 2px 0", background: (C[cls] || C.muted) + "18", border: `1px solid ${(C[cls] || C.muted)}35`, color: C[cls] || C.muted }}>
    {children}
  </span>
);

const Bdg = ({ color, children }) => (
  <span style={{ background: color + "15", border: `1px solid ${color}40`, color, padding: "2px 8px", borderRadius: "3px", fontSize: "10px", letterSpacing: "1.2px", textTransform: "uppercase", fontWeight: "600" }}>
    {children}
  </span>
);

export default function DraftAI() {
  const storeRef = useRef(createStore());
  const [apiKey, setApiKey] = useState(LIQUID_API_KEY);
  const [season, setSeason] = useState(DEFAULT_SEASON);
  const [ourTeam, setOurTeam] = useState("Team Liquid");
  const [oppTeam, setOppTeam] = useState("");
  const [radiantSide, setRadiantSide] = useState("our");
  const [firstPick, setFirstPick] = useState("our");
  const [logs, setLogs] = useState([]);
  const [appStatus, setAppStatus] = useState("idle");
  const [results, setResults] = useState(null);
  const [cmdVal, setCmdVal] = useState("");
  const [cmdHist, setCmdHist] = useState([]);
  const [llLeagues, setLlLeagues] = useState([]);
  const [loadingLL, setLoadingLL] = useState(false);
  const [llLoaded, setLlLoaded] = useState(false);
  const [proxyMode, setProxyMode] = useState(false);
  const logEnd = useRef(null);

  const addLog = useCallback((msg) => setLogs((p) => [...p, `[${new Date().toLocaleTimeString()}] ${msg}`]), []);
  useEffect(() => { logEnd.current?.scrollIntoView({ behavior: "smooth" }); }, [logs]);

  const loadLiquid = useCallback(async () => {
    if (!apiKey) return;
    setLoadingLL(true);
    setLogs([]);
    const store = storeRef.current;
    store.apiKey = apiKey;
    store.seasonTag = season;
    await probeConnectivity(apiKey, season, store, addLog);
    setProxyMode(store.proxy);
    try {
      const { leagues } = await discoverLiquidLeagues(season, apiKey, store, addLog);
      setLlLeagues(leagues);
      setLlLoaded(true);
      addLog(`✓ Loaded ${leagues.length} Liquid tournament(s)`);
    } catch (e) {
      addLog(`Error: ${e.message}`);
    }
    setLoadingLL(false);
  }, [apiKey, season, addLog]);

  const handleCmd = useCallback(async (raw) => {
    const t = raw.trim();
    const push = (...lines) => setCmdHist((h) => [...h, ...lines]);
    const store = storeRef.current;
    push(`> ${raw}`);
    if (t === "/clear") {
      storeRef.current = createStore();
      setResults(null); setLogs([]); setLlLeagues([]); setLlLoaded(false);
      push("Context cleared.");
    } else if (t === "/clear teams") {
      store.teams = {}; store.playerHeroStats = {}; store.teamHeroStats = {};
      [...store.fetched].filter((k) => ["th_","ph_","lr_"].some((p) => k.startsWith(p))).forEach((k) => store.fetched.delete(k));
      push("Team data cleared.");
    } else if (t === "/clear meta") {
      store.seasonHeroMeta = {}; store.leagueHeroStats = {};
      [...store.fetched].filter((k) => k.startsWith("lh_") || k.startsWith("sm_")).forEach((k) => store.fetched.delete(k));
      push("Meta data cleared.");
    } else if (t === "/status") {
      push(
        `Teams: ${Object.keys(store.teams).length} | Players: ${Object.keys(store.playerHeroStats).length} | Leagues: ${Object.keys(store.leagues).length}`,
        `API calls: ${store.fetched.size} | Proxy: ${store.proxy ? "Claude" : "Direct"}`,
        `Liquid: ${llLeagues.map((l) => l.league_name).join(", ") || "none"}`
      );
    } else {
      const al = t.match(/^\/add league (\d+)$/i);
      if (al) {
        push(`Fetching league ${al[1]}...`);
        fetchLeagueRoster(parseInt(al[1]), apiKey, store)
          .then(() => fetchLeagueHeroStats(parseInt(al[1]), apiKey, store))
          .then(() => setCmdHist((h) => [...h, `League ${al[1]} merged.`]))
          .catch((e) => setCmdHist((h) => [...h, `Error: ${e.message}`]));
      } else push("Unknown command. Try /clear, /status, /add league <id>");
    }
  }, [apiKey, llLeagues]);

  const runSim = useCallback(async () => {
    if (!apiKey || !ourTeam || !oppTeam) return;
    setAppStatus("loading");
    setResults(null);
    setLogs([]);
    const store = storeRef.current;
    store.apiKey = apiKey;
    store.seasonTag = season;
    store.proxy = proxyMode;
    try {
      await Promise.all([
        hydrateTeam(ourTeam, season, apiKey, store, addLog),
        hydrateTeam(oppTeam, season, apiKey, store, addLog),
        fetchSeasonHeroMeta(season, apiKey, store),
      ]);
      const radiant = radiantSide === "our" ? ourTeam : oppTeam;
      const fp = firstPick === "our" ? ourTeam : oppTeam;
      addLog("Building context packet...");
      const packet = buildContextPacket(ourTeam, oppTeam, radiant, fp, store, season, llLeagues);
      addLog("Dispatching agents...");
      const output = await runAgents(packet, addLog);
      setResults({ packet, output });
      setAppStatus("done");
      addLog("✓ Simulation complete.");
    } catch (e) {
      addLog(`Error: ${e.message}`);
      setAppStatus("error");
    }
  }, [apiKey, ourTeam, oppTeam, radiantSide, firstPick, season, proxyMode, llLeagues, addLog]);

  const inp = { width: "100%", background: C.bg, border: `1px solid ${C.border}`, color: C.text, padding: "6px 9px", borderRadius: "3px", fontFamily: "inherit", fontSize: "12px", boxSizing: "border-box", outline: "none" };
  const sel = { ...inp };
  const btn = (color, disabled) => ({ width: "100%", padding: "8px", background: color + "18", border: `1px solid ${color}55`, color, borderRadius: "3px", cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit", fontSize: "11px", letterSpacing: "1.5px", textTransform: "uppercase", fontWeight: "700", opacity: disabled ? 0.4 : 1, marginBottom: "6px" });
  const card = (c = C.border) => ({ background: C.surf, border: `1px solid ${c}`, borderRadius: "4px", padding: "13px" });
  const stitle = (c = C.accent) => ({ color: c, fontSize: "9.5px", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "10px", display: "flex", alignItems: "center", gap: "8px", fontWeight: "700" });
  const lbl = { color: C.accent, fontSize: "9.5px", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "7px", display: "block", fontWeight: "600" };
  const slbl = { color: C.muted, fontSize: "9px", letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: "4px", display: "block" };

  const runDisabled = appStatus === "loading" || !apiKey || !ourTeam || !oppTeam;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: "12.5px" }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "10px 18px", display: "flex", alignItems: "center", gap: "10px", background: C.surf, position: "sticky", top: 0, zIndex: 10 }}>
        <span style={{ color: C.accent, fontSize: "14px", fontWeight: "800", letterSpacing: "3px", textTransform: "uppercase" }}>DRAFT.AI</span>
        <Bdg color={C.accent}>Dota 2</Bdg>
        <Bdg color={C.liq}>Imprint v2</Bdg>
        {proxyMode && <Bdg color={C.MED}>Claude Proxy</Bdg>}
        {llLoaded && <Bdg color={C.liq}>Liquid ×{llLeagues.length}</Bdg>}
        {appStatus === "loading" && <Bdg color={C.MED}>Running...</Bdg>}
        {appStatus === "done" && <Bdg color={C.HIGH}>Complete</Bdg>}
        {appStatus === "error" && <Bdg color={C.risk}>Error</Bdg>}
        <span style={{ marginLeft: "auto", color: C.dim, fontSize: "10px" }}>Imprint GG v2 API</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", height: "calc(100vh - 43px)" }}>
        {/* Sidebar */}
        <div style={{ borderRight: `1px solid ${C.border}`, padding: "14px", overflowY: "auto", background: C.surf, display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ paddingBottom: "12px", borderBottom: `1px solid ${C.border}` }}>
            <span style={lbl}>API Config</span>
            <input style={{ ...inp, marginBottom: "7px", color: C.muted, fontSize: "11px" }} type="password" placeholder="Imprint API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <select style={sel} value={season} onChange={(e) => setSeason(e.target.value)}>
              <option value="2025-2026">Season 2025–2026</option>
              <option value="2024-2025">Season 2024–2025</option>
            </select>
          </div>

          <div style={{ paddingBottom: "12px", borderBottom: `1px solid ${C.border}` }}>
            <span style={lbl}>Auto-load Liquid Data</span>
            <button style={btn(C.liq, loadingLL || !apiKey)} onClick={loadLiquid} disabled={loadingLL || !apiKey}>
              {loadingLL ? "Fetching..." : llLoaded ? "↻ Reload" : "Load Last 3 Tournaments"}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", color: C.muted, fontSize: "10.5px", cursor: "pointer", marginTop: "2px" }}>
              <input type="checkbox" checked={proxyMode} onChange={(e) => { setProxyMode(e.target.checked); storeRef.current.proxy = e.target.checked; }} />
              Force Claude-proxy (CORS fix)
            </label>
            {llLeagues.length > 0 && (
              <div style={{ marginTop: "10px" }}>
                <span style={slbl}>Loaded leagues</span>
                {llLeagues.map((l, i) => (
                  <div key={l.league_id} style={{ display: "flex", alignItems: "center", gap: "5px", padding: "3px 8px", background: C.liq + "12", border: `1px solid ${C.liq}35`, borderRadius: "3px", color: C.liq, fontSize: "10.5px", marginBottom: "4px" }}>
                    <span style={{ color: C.dim, minWidth: "14px" }}>{i + 1}.</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.league_name}</span>
                    <span style={{ color: C.dim, fontSize: "9.5px" }}>#{l.league_id}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ paddingBottom: "12px", borderBottom: `1px solid ${C.border}` }}>
            <span style={lbl}>Teams</span>
            <input style={{ ...inp, marginBottom: "6px", borderColor: C.liq + "55" }} placeholder="Our team name" value={ourTeam} onChange={(e) => setOurTeam(e.target.value)} />
            <input style={{ ...inp, borderColor: C.dire + "55" }} placeholder="Opposition team name" value={oppTeam} onChange={(e) => setOppTeam(e.target.value)} />
          </div>

          <div style={{ paddingBottom: "12px", borderBottom: `1px solid ${C.border}` }}>
            <span style={lbl}>Draft Setup</span>
            <span style={slbl}>Radiant side</span>
            <select style={{ ...sel, marginBottom: "8px" }} value={radiantSide} onChange={(e) => setRadiantSide(e.target.value)}>
              <option value="our">Our team</option>
              <option value="opp">Opposition</option>
            </select>
            <span style={slbl}>First pick</span>
            <select style={sel} value={firstPick} onChange={(e) => setFirstPick(e.target.value)}>
              <option value="our">Our team</option>
              <option value="opp">Opposition</option>
            </select>
          </div>

          <button style={btn(C.accent, runDisabled)} onClick={runSim} disabled={runDisabled}>
            {appStatus === "loading" ? "Simulating..." : "Run Simulation"}
          </button>
          {!oppTeam && <div style={{ color: C.dim, fontSize: "10px", lineHeight: "1.6", marginTop: "-4px" }}>Enter opposition team to enable.</div>}
        </div>

        {/* Content */}
        <div style={{ overflowY: "auto", padding: "16px 20px", display: "flex", flexDirection: "column", gap: "14px" }}>
          {logs.length > 0 && (
            <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: "3px", padding: "10px 12px", fontSize: "11px", maxHeight: "140px", overflowY: "auto", lineHeight: "1.7", fontFamily: "inherit" }}>
              {logs.map((l, i) => (
                <div key={i} style={{ color: l.includes("Error") ? C.dire : l.includes("✓") ? C.HIGH : C.muted }}>{l}</div>
              ))}
              <div ref={logEnd} />
            </div>
          )}

          {/* Terminal */}
          <div style={{ ...card(), padding: 0 }}>
            <div style={{ padding: "9px 13px", borderBottom: `1px solid ${C.border}` }}>
              <div style={stitle()}>Terminal</div>
              <div style={{ color: C.muted, fontSize: "10.5px", lineHeight: "1.9" }}>
                {cmdHist.length === 0
                  ? <div style={{ color: C.dim }}>/clear · /status · /add league &lt;id&gt; · /clear teams · /clear meta</div>
                  : cmdHist.slice(-10).map((l, i) => <div key={i} style={{ color: l.startsWith(">") ? C.accent : C.muted }}>{l}</div>)
                }
              </div>
            </div>
            <input
              style={{ ...inp, background: "transparent", border: "none", borderTop: `1px solid ${C.border}`, color: C.accent, borderRadius: 0, padding: "9px 13px" }}
              placeholder="Enter command..."
              value={cmdVal}
              onChange={(e) => setCmdVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && cmdVal.trim()) { handleCmd(cmdVal.trim()); setCmdVal(""); } }}
            />
          </div>

          {results && (
            <>
              <div style={card(C.liq + "55")}>
                <div style={{ ...stitle(C.liq), marginBottom: "4px" }}>
                  Context Packet
                  <span style={{ color: C.muted, fontWeight: "400", fontSize: "10px" }}>{results.packet.our_team} vs {results.packet.opp_profile.team_name}</span>
                </div>
                <div style={{ color: C.dim, fontSize: "9.5px", marginBottom: "10px" }}>{results.packet.data_source}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                  {[
                    { lbl: "Our team", prof: results.packet.our_profile, color: C.liq },
                    { lbl: "Opposition", prof: results.packet.opp_profile, color: C.dire },
                  ].map(({ lbl: l, prof, color }) => (
                    <div key={l}>
                      <div style={{ color, fontSize: "11px", marginBottom: "7px", fontWeight: "700" }}>{l}: {prof.team_name}</div>
                      <div style={slbl}>Identity heroes</div>
                      <div style={{ marginBottom: "6px" }}>
                        {(prof.top_identity_heroes || []).slice(0, 5).map((h) => <Chip key={h.hero} cls="core">{h.hero} <span style={{ opacity: 0.6 }}>({h.team_games}g)</span></Chip>)}
                        {!(prof.top_identity_heroes?.length) && <span style={{ color: C.dim, fontSize: "10.5px" }}>—</span>}
                      </div>
                      <div style={slbl}>Comfort picks</div>
                      <div style={{ marginBottom: "6px" }}>
                        {(prof.comfort_picks || []).slice(0, 5).map((h) => <Chip key={h.hero} cls="comfort">{h.hero}</Chip>)}
                        {!(prof.comfort_picks?.length) && <span style={{ color: C.dim, fontSize: "10.5px" }}>—</span>}
                      </div>
                      <div style={slbl}>Habit picks</div>
                      <div>{(prof.habit_picks || []).slice(0, 3).map((h) => <Chip key={h.hero} cls="habit">{h.hero}</Chip>)}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: `1px solid ${C.border}`, display: "flex", gap: "16px" }}>
                  <div><span style={slbl}>Radiant</span><span style={{ color: C.radiant, fontSize: "12px" }}>{results.packet.radiant_team}</span></div>
                  <div><span style={slbl}>First pick</span><span style={{ color: C.green, fontSize: "12px" }}>{results.packet.first_pick_team}</span></div>
                  <div><span style={slbl}>Season</span><span style={{ color: C.muted, fontSize: "12px" }}>{results.packet.season_tag}</span></div>
                </div>
              </div>

              {[
                { key: "agentA", label: "Agent A — Draft Order & Priority", color: C.radiant },
                { key: "agentB", label: "Agent B — Our Team Comfort", color: C.green },
                { key: "agentC", label: "Agent C — Opposition Counter-picks", color: C.dire },
                { key: "agentD", label: "Agent D — Meta & Tendencies", color: C.MED },
              ].map(({ key, label, color }) => (
                <details key={key} style={card(color + "35")}>
                  <summary style={{ ...stitle(color), cursor: "pointer", userSelect: "none", marginBottom: 0 }}>{label}</summary>
                  <pre style={{ whiteSpace: "pre-wrap", color: C.text, lineHeight: "1.8", fontSize: "11.5px", margin: "12px 0 0", fontFamily: "inherit" }}>{results.output[key]}</pre>
                </details>
              ))}

              <div style={card(C.accent + "70")}>
                <div style={stitle(C.accent)}>
                  Lead Agent — Final Draft Recommendation
                  {results.output.escalations?.length > 0 && <Bdg color={C.MED}>{results.output.escalations.length} escalated → B</Bdg>}
                </div>
                <pre style={{ whiteSpace: "pre-wrap", color: C.text, lineHeight: "1.8", fontSize: "11.5px", margin: 0, fontFamily: "inherit" }}>{results.output.lead}</pre>
              </div>
            </>
          )}

          {appStatus === "idle" && !results && (
            <div style={{ color: C.dim, textAlign: "center", marginTop: "50px", lineHeight: "2.2" }}>
              <div style={{ color: C.accent, fontSize: "16px", marginBottom: "8px", letterSpacing: "3px" }}>DRAFT.AI</div>
              <div style={{ color: C.muted, fontSize: "11.5px" }}>
                {llLoaded
                  ? `Liquid data loaded (${llLeagues.length} tournaments). Enter opposition team.`
                  : `Click "Load Last 3 Tournaments" to begin.\nIf you see errors, check "Force Claude-proxy" and retry.`}
              </div>
              {llLoaded && <div style={{ marginTop: "10px", fontSize: "10.5px" }}>{llLeagues.map((l) => l.league_name).join(" · ")}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
