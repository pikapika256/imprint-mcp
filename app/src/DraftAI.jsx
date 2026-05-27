import { useState, useCallback, useRef, useEffect } from 'react'

async function apiFetch(path) {
  const r = await fetch(`/api/imprint${path}`)
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`HTTP ${r.status} ${path}: ${txt.slice(0, 200)}`)
  }
  return r.json()
}

async function callClaude(system, userMsg, webSearch = false, maxTokens = 1200) {
  const body = {
    model: 'claude-opus-4-5',
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userMsg }],
  }
  if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }]
  const r = await fetch('/api/claude/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const err = await r.text().catch(() => '')
    throw new Error(`Claude ${r.status}: ${err.slice(0, 300)}`)
  }
  const d = await r.json()
  return (d.content || []).map(b => b.type === 'text' ? b.text : '').filter(Boolean).join('\n')
}

// ── Correct 24-slot Captain's Mode sequence ─────────────────────────────────
const DRAFT_SEQUENCE = [
  {t:1,a:'ban'},{t:1,a:'ban'},{t:2,a:'ban'},{t:2,a:'ban'},{t:1,a:'ban'},{t:2,a:'ban'},{t:2,a:'ban'},
  {t:1,a:'pick'},{t:2,a:'pick'},
  {t:1,a:'ban'},{t:1,a:'ban'},{t:2,a:'ban'},
  {t:2,a:'pick'},{t:1,a:'pick'},{t:1,a:'pick'},{t:2,a:'pick'},{t:2,a:'pick'},{t:1,a:'pick'},
  {t:1,a:'ban'},{t:2,a:'ban'},{t:1,a:'ban'},{t:2,a:'ban'},
  {t:1,a:'pick'},{t:2,a:'pick'},
]

// Steep dropoff: historical leagues contribute very little unless current data is sparse.
// 2nd league: 0.3, 3rd: 0.1, 4th+: 0.05 (×0.5 again if different patch)
const LEAGUE_WEIGHTS = [1.0, 0.3, 0.1, 0.05]

// ── Patch windows — approximate Dota 2 major patch release dates ─────────────
// If a historical league's patch differs from the selected league's patch,
// apply a ×0.5 multiplier to reduce stale meta impact.
const PATCH_WINDOWS = [
  { start: '2025-03-01', patch: '7.38' },
  { start: '2024-09-01', patch: '7.37' },
  { start: '2024-05-01', patch: '7.36' },
  { start: '2024-01-01', patch: '7.35' },
  { start: '2023-09-01', patch: '7.34' },
]

function patchForDate(dateStr) {
  if (!dateStr) return null
  const d = String(dateStr).slice(0, 10)
  for (const pw of PATCH_WINDOWS) {
    if (d >= pw.start) return pw.patch
  }
  return PATCH_WINDOWS[PATCH_WINDOWS.length - 1].patch
}

// ── Session cache ────────────────────────────────────────────────────────────
function emptyCache() {
  return {
    leagueRosters:  {},
    teamLeagues:    {},
    heroStats:      {},
    leagueHeroPool: {},
    banPressure:    {},
    leagueSeries:   {},
  }
}

// ── Cache-aware fetch helpers ────────────────────────────────────────────────

async function fetchLeagueRoster(leagueId, c) {
  if (c.leagueRosters[leagueId]) return c.leagueRosters[leagueId]
  const data = await apiFetch(`/league/${leagueId}/teams`)
  const teams = Array.isArray(data) ? data : (data.teams || [])
  c.leagueRosters[leagueId] = teams
  return teams
}

async function fetchLeagueHeroPool(leagueId, c) {
  if (c.leagueHeroPool[leagueId]) return c.leagueHeroPool[leagueId]
  const data = await apiFetch(`/league/${leagueId}/heroes`)
  const heroes = data.hero_statistics?.heroes || data.heroes || []
  c.leagueHeroPool[leagueId] = heroes
  return heroes
}

async function fetchTeamHeroStats(teamId, leagueId, c) {
  const key = `${teamId}_${leagueId}`
  if (c.heroStats[key]) return c.heroStats[key]
  const data = await apiFetch(`/league/${leagueId}/team/${teamId}/heroes`)
  const heroes = data.hero_statistics?.heroes || data.heroes || []
  c.heroStats[key] = heroes
  return heroes
}

async function fetchLeagueSeries(leagueId, c) {
  if (c.leagueSeries[leagueId]) return c.leagueSeries[leagueId]
  const data = await apiFetch(`/league/${leagueId}/matches`)
  const matches = Array.isArray(data) ? data : (data.matches || data.series || data.games || [])
  c.leagueSeries[leagueId] = matches
  return matches
}

async function fetchBanPressure(teamId, leagueId, c) {
  const key = `${teamId}_${leagueId}`
  if (c.banPressure[key]) return c.banPressure[key]

  const empty = { map: {}, total: 0 }
  let seriesList = []
  try { seriesList = await fetchLeagueSeries(leagueId, c) } catch {
    c.banPressure[key] = empty
    return empty
  }

  const teamMatches = seriesList.filter(m => {
    const rId = m.radiant_team_id ?? m.radiant?.team_id ?? m.radiant_team?.team_id
    const dId = m.dire_team_id   ?? m.dire?.team_id   ?? m.dire_team?.team_id
    return rId === teamId || dId === teamId
  }).slice(-15)

  const banMap = {}
  let total = 0

  for (let i = 0; i < teamMatches.length; i += 5) {
    await Promise.all(teamMatches.slice(i, i + 5).map(async match => {
      const matchId = match.match_id || match.id || match.game_id
      if (!matchId) return
      try {
        const detail = await apiFetch(`/match/${matchId}`)
        const draft = detail.draft || detail.picks_bans || detail.picks_and_bans || []
        const rId = match.radiant_team_id ?? match.radiant?.team_id ?? match.radiant_team?.team_id
        const teamIsRadiant = rId === teamId
        for (const action of draft) {
          const isPick = action.is_pick ?? action.type === 'pick'
          if (isPick) continue
          const actIsRadiant = action.is_radiant_action ?? action.team === 'radiant'
          if (teamIsRadiant ? !actIsRadiant : actIsRadiant) {
            const hero = action.hero_name || action.name || action.hero
            if (hero) banMap[hero] = (banMap[hero] || 0) + 1
          }
        }
        total++
      } catch { /* skip */ }
    }))
  }

  const result = { map: banMap, total }
  c.banPressure[key] = result
  return result
}

// Returns [{leagueId, patch}] sorted by leagueId descending
async function findTeamLeagues(teamId, allLeagues, season, c) {
  const key = `${teamId}_${season}`
  if (c.teamLeagues[key]) return c.teamLeagues[key]
  const found = []
  await Promise.all(allLeagues.map(async league => {
    try {
      const teams = await fetchLeagueRoster(league.league_id, c)
      if (teams.some(t => t.team_id === teamId)) {
        found.push({
          leagueId: league.league_id,
          patch: patchForDate(league.end_date || league.start_date),
        })
      }
    } catch { /* skip */ }
  }))
  found.sort((a, b) => b.leagueId - a.leagueId)
  c.teamLeagues[key] = found
  return found
}

// leagueEntries: [{leagueId, patch}]; currentPatch: string|null
// Returns [{heroes, weight, leagueId, patch, patchMultiplier}]
async function fetchWeightedHeroStats(teamId, leagueEntries, c, currentPatch) {
  const entries = await Promise.all(
    leagueEntries.slice(0, 4).map(async ({ leagueId, patch }, idx) => {
      try {
        const heroes = await fetchTeamHeroStats(teamId, leagueId, c)
        const patchMultiplier = (!currentPatch || !patch || patch === currentPatch) ? 1.0 : 0.5
        const weight = (LEAGUE_WEIGHTS[idx] ?? 0.2) * patchMultiplier
        return { heroes, weight, leagueId, patch, patchMultiplier }
      } catch { return null }
    })
  )
  return entries.filter(Boolean)
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function parseWR(s) { return parseFloat(String(s || '0')) || 0 }

// Bayesian regression toward meta WR — reduces WR impact when sample size is low.
// At wGames=0: full regression to metaWR. At wGames=BAYES_PRIOR: 50% blend. At 20+: ~80% raw WR.
const BAYES_PRIOR = 5

function bayesAdjustedWR(rawWR, wGames, metaWR) {
  return (rawWR * wGames + metaWR * BAYES_PRIOR) / (wGames + BAYES_PRIOR)
}

function classifyHeroesWeighted(weightedEntries, leagueHeroes, banData) {
  const leagueTotal = leagueHeroes.reduce((s, h) => s + (h.match_count || 0), 0)

  const heroAgg = {}
  for (const { heroes, weight } of weightedEntries) {
    for (const h of heroes) {
      const name = h.name || h.raw_name
      if (!name) continue
      if (!heroAgg[name]) heroAgg[name] = { name, wGames: 0, wWins: 0 }
      const games = h.match_count || 0
      heroAgg[name].wGames += games * weight
      heroAgg[name].wWins  += (games * parseWR(h.win_rate) / 100) * weight
    }
  }

  const totalTeamWGames = Object.values(heroAgg).reduce((s, h) => s + h.wGames, 0)

  return Object.values(heroAgg).map(h => {
    const lh       = leagueHeroes.find(x => x.name === h.name || x.raw_name === h.name) || {}
    const rawWR    = h.wGames > 0 ? (h.wWins / h.wGames) * 100 : 0
    const metaWR   = parseWR(lh.win_rate) || 50
    // Regress team WR toward meta WR when weighted sample is small
    const teamWR   = bayesAdjustedWR(rawWR, h.wGames, metaWR)
    const metaGames = lh.match_count || 0
    const metaPR   = leagueTotal > 0 ? (metaGames / leagueTotal) * 100 : 0
    const wrDelta  = teamWR - metaWR
    const prRatio  = metaPR > 0 && totalTeamWGames > 0
      ? (h.wGames / totalTeamWGames) / (metaPR / 100) : 0
    const bp       = banData.total > 0 ? (banData.map[h.name] || 0) / banData.total : 0

    let cls = 'situational'
    if      (prRatio >= 1.5 && (wrDelta >= 5 || bp >= 0.3)) cls = 'core_identity'
    else if (prRatio >= 1.5 && wrDelta < 0)                  cls = 'habit_pick'
    else if (bp >= 0.4)                                       cls = 'high_ban_target'
    else if (wrDelta >= 5 || bp >= 0.25)                     cls = 'comfort_pick'
    else if (wrDelta <= -5)                                   cls = 'risk_pick'

    return {
      hero:            h.name,
      weighted_games:  Math.round(h.wGames * 10) / 10,
      team_win_rate:   Math.round(teamWR * 10) / 10,
      raw_win_rate:    Math.round(rawWR * 10) / 10,
      meta_win_rate:   metaWR,
      win_rate_delta:  Math.round(wrDelta * 10) / 10,
      pick_rate_ratio: Math.round(prRatio * 100) / 100,
      ban_pressure:    Math.round(bp * 100) / 100,
      classification:  cls,
      confidence:      h.wGames >= 10 ? 'HIGH' : h.wGames >= 5 ? 'MEDIUM' : 'LOW',
    }
  }).sort((a, b) => b.weighted_games - a.weighted_games)
}

function buildContextPacket({ ourTeam, oppTeam, ourWeighted, oppWeighted, ourBanData, oppBanData, leagueHeroes, league, radiant, firstPick }) {
  const fpIsOur = firstPick === ourTeam.team_name
  const t1 = fpIsOur ? ourTeam.team_name : oppTeam.team_name
  const t2 = fpIsOur ? oppTeam.team_name : ourTeam.team_name

  const draftTable = DRAFT_SEQUENCE.map((s, i) =>
    `${i + 1}:${s.t === 1 ? t1 : t2} ${s.a.toUpperCase()}`
  ).join(' | ')

  const profile = (team, weighted, banData) => {
    const classified = classifyHeroesWeighted(weighted, leagueHeroes, banData)
    const topBanned = Object.entries(banData.map)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([hero, count]) => ({
        hero,
        ban_pressure: banData.total > 0 ? Math.round(count / banData.total * 100) / 100 : 0,
      }))
    // roster_by_position for agent position coverage enforcement
    const rosterByPos = {}
    for (const p of (team.players || [])) {
      if (p.position) rosterByPos[String(p.position)] = p.account_name
    }
    return {
      team_id:          team.team_id,
      team_name:        team.team_name,
      record:           `${team.wins}W-${team.losses}L`,
      win_rate:         team.win_rate,
      imprint_rating:   team.average_team_imprint_rating,
      rating_label:     team.rating_label,
      players:          (team.players || []).map(p => ({ account_id: p.account_id, account_name: p.account_name, position: p.position })),
      roster_by_position: rosterByPos,
      hero_pool:         classified.slice(0, 20),
      top_identity_heroes: classified.filter(h => h.classification === 'core_identity').slice(0, 5),
      comfort_picks:    classified.filter(h => h.classification === 'comfort_pick').slice(0, 8),
      high_ban_targets: classified.filter(h => h.classification === 'high_ban_target').slice(0, 5),
      habit_picks:      classified.filter(h => h.classification === 'habit_pick'),
      risk_picks:       classified.filter(h => h.classification === 'risk_pick'),
      top_banned_against: topBanned,
      leagues_analysed: weighted.map(e => ({ leagueId: e.leagueId, patch: e.patch, weight: e.weight })),
    }
  }

  return {
    simulation_id:    `${ourTeam.team_name}_vs_${oppTeam.team_name}_${Date.now()}`,
    our_team:         ourTeam.team_name,
    opposition_team:  oppTeam.team_name,
    radiant_team:     radiant,
    first_pick_team:  firstPick,
    league_id:        league.league_id,
    league_name:      league.league_name,
    our_profile:      profile(ourTeam, ourWeighted, ourBanData),
    opp_profile:      profile(oppTeam, oppWeighted, oppBanData),
    league_hero_pool_size: leagueHeroes.length,
    draft_format:     draftTable,
    draft_phases: {
      phase1_bans:  'slots 1-7:   T1B T1B T2B T2B T1B T2B T2B',
      phase2_picks: 'slots 8-9:   T1P T2P',
      phase3_bans:  'slots 10-12: T1B T1B T2B',
      phase4_picks: 'slots 13-18: T2P T1P T1P T2P T2P T1P',
      phase5_bans:  'slots 19-22: T1B T2B T1B T2B',
      phase6_picks: 'slots 23-24: T1P T2P',
    },
    generated_at: new Date().toISOString(),
  }
}

// ── Agent prompts ─────────────────────────────────────────────────────────────

const DRAFT_LEGEND = `Captain's Mode (T1=first-pick team, T2=second-pick team):
Phase 1 Bans  (slots  1-7):  T1B T1B T2B T2B T1B T2B T2B
Phase 2 Picks (slots  8-9):  T1P T2P
Phase 3 Bans  (slots 10-12): T1B T1B T2B
Phase 4 Picks (slots 13-18): T2P T1P T1P T2P T2P T1P
Phase 5 Bans  (slots 19-22): T1B T2B T1B T2B
Phase 6 Picks (slots 23-24): T1P T2P`

const SYS = {
  lead: `You are the lead Dota 2 draft strategist FOR our team. Data from Imprint GG v2.
Review all sub-agent outputs. Your response MUST follow this EXACT format — do not deviate:

DRAFT TABLE:
\`\`\`json
[
  {"slot":1,"phase":"Phase 1 — Bans","action":"ban","team":"<exact team name>","hero":"<hero name>","position":null,"reasoning":"<one concise line, cite ban% if from top_banned_against>","confidence":"HIGH"},
  {"slot":2,...},
  ... all 24 slots ...
]
\`\`\`

STRATEGY:
<3-5 sentence strategy summary and win conditions>

RULES:
1. All 24 slots required. action = "ban" or "pick". confidence = "HIGH", "MEDIUM", or "LOW".
2. UNIQUENESS: every hero must appear at most once across all 24 slots. Before filling each slot, mentally check your running list of already-used heroes and never repeat one — not between picks, not between bans, not between picks and bans.
3. For OUR TEAM's pick slots: position must be 1–5, assigned from our_profile.roster_by_position.
4. POSITION ACCURACY: only assign a hero to a position if that hero is commonly played there in pro Dota. Do not place a carry hero on a position 4/5 player or a hard support on position 1/2. If a player's known hero pool doesn't fit the available hero, note low confidence.
5. POSITION COVERAGE CHECK: verify positions 1,2,3,4,5 are each assigned exactly once across our picks before finalising. If any position is doubled or missing, revise.
6. SUPPORT PRIORITY TIEBREAKER: when two heroes offer similar value for a pick slot, prefer whichever fills an unassigned support position (4 or 5) over doubling up on an already-covered core position.
7. ROLE-AWARE BANNING: track which positions are already locked in by picks as you fill each phase. In later ban phases (3 and 5), focus bans on roles the opposition still needs to fill or heroes that threaten our unassigned positions — do not waste late bans on roles both teams have already resolved.
8. CONFIDENCE-PHASE RULE: hero confidence reflects how much current-tournament data supports the pick. In early phases (slots 1–12) use only HIGH and MEDIUM confidence heroes. Only introduce LOW confidence heroes in later phases (slots 13+) after bans and deny-picks have narrowed the pool and no HIGH/MEDIUM option adequately fills the remaining position. Never use a LOW confidence hero when a HIGH or MEDIUM option is still available for that slot.
8. For opposition picks: position = null.
9. Ban pressure: when banning a hero from top_banned_against, cite the ban rate % in reasoning.
10. LOW-confidence picks: still fill the slot. Add ESCALATE_TO_B lines AFTER the JSON block if needed.
${DRAFT_LEGEND}`,

  a: `Dota 2 draft order specialist — sequencing and priority.
1. Pick/ban priority considering first/second pick, radiant/dire, identity heroes to deny or secure.
2. For each of 24 slots: offensive vs defensive, top targets for this slot.
3. ROLE-AWARE BAN TARGETING: as picks are made and positions are filled, shift ban focus to roles still contested. Early bans should target the opposition's highest-threat identity heroes. Mid/late bans should target roles the opposition still needs — once a position is secured by both teams, deprioritise banning further heroes in that role.
4. UNIQUENESS: no hero can appear more than once across bans and picks combined.
5. CONFIDENCE-PHASE RULE: treat LOW confidence heroes (weighted_games < 5) as backup options only. Recommend them only in later phases (slots 13+) when bans and deny-picks have eliminated the HIGH/MEDIUM alternatives for a position. Flag when you're forced to fall back to historical data.
6. Identify tempo-critical phases and flex windows.
7. Priority ban list (top 5) and pick list (top 5) with one-line reasoning each, noting position filled.
${DRAFT_LEGEND}`,

  b: `Dota 2 team comfort analyst — OUR TEAM ONLY.
1. Core identity: high pick_rate_ratio + strong WR — always ban or secure.
2. Comfort picks: win_rate_delta ≥ 5 — strong secondary options.
3. Habit picks: high pick rate + below-meta WR — caution, exploitable.
4. High ban targets: ban_pressure ≥ 0.4 — opponents confirmed fear these.
5. top_banned_against = opponent-confirmed comfort heroes; weight equal to core_identity.
6. Risk picks: below-meta WR — avoid unless forced.
7. Tier list: Tier 1 / Tier 2 / Tier 3 by position (1-5). Separate HIGH/MEDIUM confidence heroes (recent tournament data) from LOW confidence (historical only — last resort when pool narrows).

BAN INTELLIGENCE SECTION (required — list every hero with ban_pressure ≥ 0.2):
Format: "Hero: XX% banned against us — [what this tells us about their comfort / draft priority]"

For ESCALATION requests: TIEBREAK_DECISION: <hero>: <reason>`,

  c: `Dota 2 opposition counter-pick analyst — OPPOSITION ONLY.
1. opp_profile.top_banned_against — heroes opponents most fear from this team; prioritise banning.
2. opp_profile.high_ban_targets — heavily banned, confirmed high-threat.
3. opp_profile.top_identity_heroes — must bans if not covered above.
4. Our heroes that counter opposition playstyle / lineup composition.
5. Hard-counters to our potential picks.
6. Deliverables: top 5 must-ban targets | top 5 counter-picks for us | top 3 heroes to avoid.

OPPOSITION BAN INTELLIGENCE SECTION (required — list every opp hero with ban_pressure ≥ 0.2 from opp_profile.top_banned_against):
Format: "Hero: XX% ban rate — [whether we should ban it, secure it, or use it as a window]"`,

  d: `Dota 2 meta analyst. You may use web search for current patch notes.
1. Compare team hero pools against current patch meta — always frame meta assessments by position/role (e.g. "strong carry", "dominant offlaner") not just hero name.
2. Pro vs pub gap for key heroes in this matchup.
3. Tendency signals: core_identity to respect, habit_picks to exploit.
4. Confidence uses weighted_games: HIGH ≥ 10 / MEDIUM ≥ 5 / LOW < 5. Flag any heroes with LOW confidence whose win_rate_delta may be inflated by small samples.
5. ROLE ACCURACY: do not assign meta observations to a player if that player does not typically play that hero's role. Check roster_by_position before suggesting any hero–player pairing.
6. 3 key meta observations relevant to this matchup, each specifying the position/role it applies to.`,
}

// ── Lead output parser ────────────────────────────────────────────────────────

function parseDraftTable(text) {
  try {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/)
    const stratMatch = text.match(/STRATEGY:\s*([\s\S]*?)(?:ESCALATE_TO_B:|$)/)
    if (jsonMatch) {
      const slots = JSON.parse(jsonMatch[1].trim())
      return {
        slots: Array.isArray(slots) ? slots : [],
        strategy: stratMatch ? stratMatch[1].trim() : '',
        raw: text,
      }
    }
  } catch { /* fall through */ }
  return { slots: [], strategy: text, raw: text }
}

async function runAgents(packet, addLog) {
  const ps = JSON.stringify(packet, null, 2)
  addLog('Agents A / B / C / D running in parallel…')
  const [aOut, bOut, cOut, dOut] = await Promise.all([
    callClaude(SYS.a, `Context:\n${ps}`).catch(e => `Agent A error: ${e.message}`),
    callClaude(SYS.b, `Context:\n${ps}`).catch(e => `Agent B error: ${e.message}`),
    callClaude(SYS.c, `Context:\n${ps}`).catch(e => `Agent C error: ${e.message}`),
    callClaude(SYS.d, `Context:\n${ps}`, true).catch(e => `Agent D error: ${e.message}`),
  ])
  addLog('Lead synthesis…')
  const leadIn = `Context:\n${ps}\n\n--- AGENT A ---\n${aOut}\n\n--- AGENT B ---\n${bOut}\n\n--- AGENT C ---\n${cOut}\n\n--- AGENT D ---\n${dOut}`
  const leadOut = await callClaude(SYS.lead, leadIn, false, 3000).catch(e => `Lead error: ${e.message}`)

  const escalations = []
  const er = /ESCALATE_TO_B:\s*(\d+):\s*([^:]+):\s*(.+)/g
  let m
  while ((m = er.exec(leadOut)) !== null)
    escalations.push({ slot: m[1], candidates: m[2].trim(), reason: m[3].trim() })

  let finalLead = leadOut
  if (escalations.length > 0) {
    addLog(`${escalations.length} escalation(s) → Agent B tiebreak…`)
    const escIn =
      `Context:\n${ps}\n\nEscalations:\n` +
      escalations.map((e, i) => `${i + 1}. slot:${e.slot} candidates:${e.candidates} conflict:${e.reason}`).join('\n')
    const bt = await callClaude(SYS.b, escIn).catch(e => `B tiebreak error: ${e.message}`)
    finalLead += `\n\n--- AGENT B TIEBREAK ---\n${bt}`
    addLog('Tiebreaks resolved.')
  }

  const parsed = parseDraftTable(finalLead)
  return { agentA: aOut, agentB: bOut, agentC: cOut, agentD: dOut, lead: finalLead, parsed, escalations }
}

// ── UI tokens ─────────────────────────────────────────────────────────────────

const C = {
  bg: '#080b10', surf: '#0d1117', border: '#1a2535',
  accent: '#00e5ff', green: '#00ff88', text: '#c8d6e5',
  muted: '#546e7a', dim: '#37474f',
  radiant: '#4dd0e1', dire: '#ef5350',
  HIGH: '#00e676', MED: '#ffca28', LOW: '#ff7043',
  core: '#b39ddb', comfort: '#4dd0e1', habit: '#ffb74d', risk: '#ef5350',
  high_ban_target: '#ff6b35',
  liq: '#0099ff',
}

const Bdg = ({ color, children }) => (
  <span style={{
    background: color + '18', border: `1px solid ${color}50`, color,
    padding: '2px 8px', borderRadius: '3px', fontSize: '10px',
    letterSpacing: '1.2px', textTransform: 'uppercase', fontWeight: '600',
    whiteSpace: 'nowrap',
  }}>
    {children}
  </span>
)

const Chip = ({ cls, children }) => (
  <span style={{
    display: 'inline-flex', alignItems: 'center',
    padding: '2px 7px', borderRadius: '3px', fontSize: '11px',
    margin: '2px 2px 2px 0',
    background: (C[cls] || C.muted) + '18',
    border: `1px solid ${(C[cls] || C.muted)}35`,
    color: C[cls] || C.muted,
  }}>
    {children}
  </span>
)

const Label = ({ children, color }) => (
  <span style={{
    color: color || C.accent, fontSize: '9.5px', letterSpacing: '2px',
    textTransform: 'uppercase', marginBottom: '7px', display: 'block', fontWeight: '700',
  }}>
    {children}
  </span>
)

const inp = {
  width: '100%', background: '#060a0f', border: `1px solid ${C.border}`,
  color: C.text, padding: '6px 9px', borderRadius: '3px',
  fontFamily: 'inherit', fontSize: '12px', outline: 'none',
}

const btn = (color, disabled) => ({
  width: '100%', padding: '8px', marginBottom: '6px',
  background: color + '18', border: `1px solid ${color}55`, color,
  borderRadius: '3px', cursor: disabled ? 'not-allowed' : 'pointer',
  fontFamily: 'inherit', fontSize: '11px', letterSpacing: '1.5px',
  textTransform: 'uppercase', fontWeight: '700', opacity: disabled ? 0.4 : 1,
})

const TeamCard = ({ team, color }) => {
  if (!team) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', marginTop: '6px', borderRadius: '3px', background: color + '10', border: `1px solid ${color}30` }}>
      {team.team_logo_src && (
        <img src={team.team_logo_src} alt="" width={24} height={24}
          style={{ borderRadius: '2px', flexShrink: 0, objectFit: 'contain' }}
          onError={e => { e.target.style.display = 'none' }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color, fontSize: '12px', fontWeight: '700', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{team.team_name}</div>
        <div style={{ color: C.muted, fontSize: '10px' }}>{team.wins}W-{team.losses}L · {team.win_rate} · ★ {team.average_team_imprint_rating}</div>
      </div>
    </div>
  )
}

// ── Draft table component ─────────────────────────────────────────────────────

function phaseForSlot(slot) {
  if (slot <= 7)  return 'Phase 1 — Bans'
  if (slot <= 9)  return 'Phase 2 — Picks'
  if (slot <= 12) return 'Phase 3 — Bans'
  if (slot <= 18) return 'Phase 4 — Picks'
  if (slot <= 22) return 'Phase 5 — Bans'
  return 'Phase 6 — Picks'
}

const PHASES = ['Phase 1 — Bans', 'Phase 2 — Picks', 'Phase 3 — Bans', 'Phase 4 — Picks', 'Phase 5 — Bans', 'Phase 6 — Picks']

function DraftTable({ slots, ourTeamName, oppTeamName }) {
  if (!slots || slots.length === 0) return null
  return (
    <div style={{ marginBottom: '12px' }}>
      {PHASES.map(phase => {
        const phaseSlots = slots.filter(s => phaseForSlot(s.slot) === phase)
        if (phaseSlots.length === 0) return null
        const isBanPhase = phase.includes('Bans')
        return (
          <div key={phase} style={{ marginBottom: '10px' }}>
            <div style={{
              color: isBanPhase ? C.dire : C.green,
              fontSize: '8.5px', letterSpacing: '2px', textTransform: 'uppercase',
              fontWeight: '700', marginBottom: '4px', paddingBottom: '3px',
              borderBottom: `1px solid ${(isBanPhase ? C.dire : C.green)}25`,
            }}>
              {phase}
            </div>
            {phaseSlots.map(s => {
              const isOurs = s.team === ourTeamName
              const isBan = s.action === 'ban'
              const rowColor = isOurs ? (isBan ? C.dire : C.liq) : C.muted
              const confColor = s.confidence === 'HIGH' ? C.HIGH : s.confidence === 'MEDIUM' ? C.MED : C.LOW
              return (
                <div key={s.slot} style={{
                  display: 'grid',
                  gridTemplateColumns: '22px 40px 110px 110px 28px 1fr 56px',
                  gap: '5px', alignItems: 'start',
                  padding: '3px 5px', borderRadius: '2px', marginBottom: '2px',
                  background: isOurs ? rowColor + '0a' : 'transparent',
                  borderLeft: `2px solid ${rowColor}50`,
                }}>
                  <span style={{ color: C.dim, fontSize: '9.5px', paddingTop: '1px' }}>{s.slot}</span>
                  <span style={{
                    fontSize: '8.5px', fontWeight: '700', letterSpacing: '0.8px', textTransform: 'uppercase',
                    color: isBan ? C.dire : C.green, paddingTop: '1px',
                  }}>
                    {isBan ? 'BAN' : 'PICK'}
                  </span>
                  <span style={{ color: rowColor, fontSize: '10px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {(s.team || '').split(' ').slice(0, 2).join(' ')}
                  </span>
                  <span style={{ color: C.text, fontSize: '11px', fontWeight: '700' }}>{s.hero || '?'}</span>
                  <span style={{ color: C.muted, fontSize: '9.5px', paddingTop: '1px' }}>
                    {s.position ? `P${s.position}` : ''}
                  </span>
                  <span style={{ color: C.muted, fontSize: '9.5px', lineHeight: '1.5' }}>{s.reasoning}</span>
                  <span style={{
                    fontSize: '8.5px', fontWeight: '700', color: confColor,
                    letterSpacing: '0.5px', textAlign: 'right', paddingTop: '1px',
                  }}>
                    {s.confidence}
                  </span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ── Ban Intelligence panel ────────────────────────────────────────────────────

function BanIntelligence({ ourProfile, oppProfile }) {
  const hasData = (ourProfile.top_banned_against?.length > 0) || (oppProfile.top_banned_against?.length > 0)
  if (!hasData) return null
  return (
    <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: `1px solid ${C.border}` }}>
      <div style={{ color: C.accent, fontSize: '9px', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: '700', marginBottom: '10px' }}>
        Ban Intelligence
        <span style={{ color: C.dim, fontWeight: '400', fontSize: '9px', letterSpacing: '0', marginLeft: '8px' }}>
          (heroes opponents chose to ban against each team)
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {[
          { prof: ourProfile,  color: C.liq },
          { prof: oppProfile, color: C.dire },
        ].map(({ prof, color }) => (
          <div key={prof.team_name}>
            <div style={{ color, fontSize: '10px', fontWeight: '700', marginBottom: '7px' }}>{prof.team_name}</div>
            {(prof.top_banned_against || []).length === 0
              ? <span style={{ color: C.dim, fontSize: '9.5px' }}>No ban data from matches</span>
              : (prof.top_banned_against || []).map(h => {
                  const pct = Math.round(h.ban_pressure * 100)
                  const barColor = pct >= 40 ? C.dire : pct >= 20 ? C.MED : C.dim
                  return (
                    <div key={h.hero} style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '5px' }}>
                      <span style={{ color: C.text, fontSize: '10px', minWidth: '90px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.hero}</span>
                      <div style={{ flex: 1, height: '4px', background: C.border, borderRadius: '2px', minWidth: '40px' }}>
                        <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: barColor, borderRadius: '2px', transition: 'width 0.3s' }} />
                      </div>
                      <span style={{ color: barColor, fontSize: '9.5px', minWidth: '28px', textAlign: 'right', fontWeight: '600' }}>{pct}%</span>
                    </div>
                  )
                })
            }
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function DraftAI() {
  const [anthropicKeyOk, setAnthropicKeyOk] = useState(false)
  const [season, setSeason] = useState('2025-2026')
  const [leagues, setLeagues] = useState([])
  const [leagueSearch, setLeagueSearch] = useState('')
  const [selectedLeague, setSelectedLeague] = useState(null)
  const [leagueTeams, setLeagueTeams] = useState([])
  const [loadingLeagues, setLoadingLeagues] = useState(false)
  const [loadingTeams, setLoadingTeams] = useState(false)
  const [ourTeam, setOurTeam] = useState(null)
  const [oppTeam, setOppTeam] = useState(null)
  const [radiantSide, setRadiantSide] = useState('our')
  const [firstPick, setFirstPick] = useState('our')
  const [logs, setLogs] = useState([])
  const [appStatus, setAppStatus] = useState('idle')
  const [results, setResults] = useState(null)
  const [cmdVal, setCmdVal] = useState('')
  const [cmdHist, setCmdHist] = useState([])

  const cache = useRef(emptyCache())
  const logEnd = useRef(null)

  const addLog = useCallback(msg =>
    setLogs(p => [...p, `[${new Date().toLocaleTimeString()}] ${msg}`]), [])
  useEffect(() => { logEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])
  useEffect(() => { cache.current = emptyCache() }, [season])

  useEffect(() => {
    fetch('/api/claude/v1/models', { headers: { 'Content-Type': 'application/json' } })
      .then(r => setAnthropicKeyOk(r.status !== 401 && r.status !== 403))
      .catch(() => setAnthropicKeyOk(false))
  }, [])

  const loadLeagues = useCallback(async () => {
    setLoadingLeagues(true)
    setLeagues([])
    setSelectedLeague(null)
    setLeagueTeams([])
    setOurTeam(null)
    setOppTeam(null)
    try {
      const data = await apiFetch(`/season/${season}/leagues`)
      const list = Array.isArray(data) ? data : (data.leagues || [])
      list.sort((a, b) => (b.league_id || 0) - (a.league_id || 0))
      setLeagues(list)
      addLog(`${list.length} leagues found for season ${season}.`)
    } catch (e) { addLog(`Error loading leagues: ${e.message}`) }
    setLoadingLeagues(false)
  }, [season, addLog])

  const selectLeague = useCallback(async (league) => {
    setSelectedLeague(league)
    setLeagueTeams([])
    setOurTeam(null)
    setOppTeam(null)
    setLoadingTeams(true)
    try {
      const teams = await fetchLeagueRoster(league.league_id, cache.current)
      setLeagueTeams(teams.sort((a, b) => (b.wins || 0) - (a.wins || 0)))
      addLog(`${teams.length} teams loaded for league #${league.league_id}.`)
    } catch (e) { addLog(`Error loading teams: ${e.message}`) }
    setLoadingTeams(false)
  }, [addLog])

  const runSim = useCallback(async () => {
    if (!ourTeam || !oppTeam || !selectedLeague) return
    setAppStatus('loading')
    setResults(null)
    setLogs([])
    const lid = selectedLeague.league_id
    const c = cache.current
    const currentPatch = patchForDate(selectedLeague.end_date || selectedLeague.start_date)
    if (currentPatch) addLog(`Selected league patch: ${currentPatch}`)

    try {
      addLog('Scanning historical league participation…')
      const [ourLeagueEntries, oppLeagueEntries] = await Promise.all([
        findTeamLeagues(ourTeam.team_id, leagues, season, c),
        findTeamLeagues(oppTeam.team_id, leagues, season, c),
      ])
      addLog(`${ourTeam.team_name}: ${ourLeagueEntries.length} league(s) | ${oppTeam.team_name}: ${oppLeagueEntries.length} league(s)`)

      addLog('Fetching weighted hero statistics…')
      const [ourWeighted, oppWeighted, leagueHeroes] = await Promise.all([
        fetchWeightedHeroStats(ourTeam.team_id, ourLeagueEntries, c, currentPatch),
        fetchWeightedHeroStats(oppTeam.team_id, oppLeagueEntries, c, currentPatch),
        fetchLeagueHeroPool(lid, c),
      ])

      // Log patch weight info
      const patchLog = (name, weighted) =>
        weighted.map(e => `${e.patch ?? '?'}×${e.weight.toFixed(2)}`).join(' ')
      if (ourWeighted.length) addLog(`${ourTeam.team_name} patches: ${patchLog(ourTeam.team_name, ourWeighted)}`)
      if (oppWeighted.length) addLog(`${oppTeam.team_name} patches: ${patchLog(oppTeam.team_name, oppWeighted)}`)

      addLog('Fetching ban pressure data…')
      const [ourBanData, oppBanData] = await Promise.all([
        fetchBanPressure(ourTeam.team_id, lid, c),
        fetchBanPressure(oppTeam.team_id, lid, c),
      ])
      addLog(`Ban pressure: ${ourTeam.team_name} ${ourBanData.total} matches | ${oppTeam.team_name} ${oppBanData.total} matches`)

      const radiant = radiantSide === 'our' ? ourTeam.team_name : oppTeam.team_name
      const fp      = firstPick   === 'our' ? ourTeam.team_name : oppTeam.team_name

      addLog('Building context packet…')
      const packet = buildContextPacket({
        ourTeam, oppTeam, ourWeighted, oppWeighted, ourBanData, oppBanData,
        leagueHeroes, league: selectedLeague, radiant, firstPick: fp,
      })

      addLog('Dispatching agents…')
      const output = await runAgents(packet, addLog)

      setResults({ packet, output })
      setAppStatus('done')
      addLog('✓ Simulation complete.')
    } catch (e) {
      addLog(`Error: ${e.message}`)
      setAppStatus('error')
    }
  }, [ourTeam, oppTeam, selectedLeague, radiantSide, firstPick, leagues, season, addLog])

  const handleCmd = useCallback(async (raw) => {
    const t = raw.trim()
    const push = (...lines) => setCmdHist(h => [...h, ...lines])
    push(`> ${raw}`)
    if (t === '/clear') {
      setResults(null); setLogs([]); setAppStatus('idle'); push('Cleared.')
    } else if (t === '/cache clear') {
      cache.current = emptyCache(); push('Cache cleared.')
    } else if (t === '/cache') {
      const c = cache.current
      push(
        `leagueRosters:  ${Object.keys(c.leagueRosters).length} entries`,
        `teamLeagues:    ${Object.keys(c.teamLeagues).length} entries`,
        `heroStats:      ${Object.keys(c.heroStats).length} entries`,
        `leagueHeroPool: ${Object.keys(c.leagueHeroPool).length} entries`,
        `banPressure:    ${Object.keys(c.banPressure).length} entries`,
        `leagueSeries:   ${Object.keys(c.leagueSeries).length} entries`,
      )
    } else if (t === '/status') {
      push(
        `Season: ${season} | Leagues loaded: ${leagues.length}`,
        `Selected: ${selectedLeague?.league_name || 'none'} (#${selectedLeague?.league_id || '—'})`,
        `Our: ${ourTeam?.team_name || 'none'} | Opp: ${oppTeam?.team_name || 'none'}`,
        `Status: ${appStatus}`,
      )
    } else {
      const al = t.match(/^\/league (\d+)$/i)
      if (al) {
        const lid = parseInt(al[1])
        push(`Loading league ${lid}…`)
        fetchLeagueRoster(lid, cache.current)
          .then(teams => {
            setSelectedLeague({ league_id: lid, league_name: `League ${lid}` })
            setLeagueTeams(teams.sort((a, b) => (b.wins || 0) - (a.wins || 0)))
            setCmdHist(h => [...h, `Loaded ${teams.length} teams from league ${lid}.`])
          })
          .catch(e => setCmdHist(h => [...h, `Error: ${e.message}`]))
      } else {
        push('Commands: /clear · /status · /league <id> · /cache · /cache clear')
      }
    }
  }, [season, leagues, selectedLeague, ourTeam, oppTeam, appStatus])

  const filteredLeagues = leagues.filter(l => {
    if (!leagueSearch) return true
    const q = leagueSearch.toLowerCase()
    return String(l.league_id).includes(q) ||
      (l.league_name || '').toLowerCase().includes(q) ||
      (l.name || '').toLowerCase().includes(q)
  })

  const runDisabled = appStatus === 'loading' || !ourTeam || !oppTeam || !selectedLeague

  const card = (c = C.border) => ({
    background: C.surf, border: `1px solid ${c}`, borderRadius: '4px', padding: '13px',
  })
  const stitle = (c = C.accent) => ({
    color: c, fontSize: '9.5px', letterSpacing: '2px', textTransform: 'uppercase',
    marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '700',
  })

  return (
    <div style={{ background: C.bg, height: '100vh', color: C.text, fontFamily: "'JetBrains Mono','Fira Code','Consolas',monospace", fontSize: '12.5px', display: 'flex', flexDirection: 'column' }}>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: '9px 18px', display: 'flex', alignItems: 'center', gap: '10px', background: C.surf, flexShrink: 0 }}>
        <span style={{ color: C.accent, fontSize: '14px', fontWeight: '800', letterSpacing: '3px' }}>DRAFT.AI</span>
        <Bdg color={C.accent}>Dota 2</Bdg>
        <Bdg color={C.liq}>Imprint v2</Bdg>
        {anthropicKeyOk ? <Bdg color={C.HIGH}>Claude ✓</Bdg> : <Bdg color={C.LOW}>Claude — add key to .env</Bdg>}
        {appStatus === 'loading' && <Bdg color={C.MED}>Running…</Bdg>}
        {appStatus === 'done'    && <Bdg color={C.HIGH}>Complete</Bdg>}
        {appStatus === 'error'   && <Bdg color={C.LOW}>Error</Bdg>}
        {selectedLeague && (
          <span style={{ marginLeft: 'auto', color: C.dim, fontSize: '10px', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: '280px' }}>
            {selectedLeague.league_name || `League #${selectedLeague.league_id}`}
          </span>
        )}
      </div>

      {/* Body */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', flex: 1, overflow: 'hidden' }}>

        {/* Sidebar */}
        <div style={{ borderRight: `1px solid ${C.border}`, padding: '14px', overflowY: 'auto', background: C.surf, display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Season */}
          <div style={{ paddingBottom: '12px', borderBottom: `1px solid ${C.border}` }}>
            <Label>Season</Label>
            <select style={{ ...inp, marginBottom: '8px' }} value={season} onChange={e => setSeason(e.target.value)}>
              <option value="2025-2026">2025 – 2026</option>
              <option value="2024-2025">2024 – 2025</option>
            </select>
            <button style={btn(C.accent, loadingLeagues)} onClick={loadLeagues} disabled={loadingLeagues}>
              {loadingLeagues ? 'Loading…' : 'Load Leagues'}
            </button>
          </div>

          {/* League picker */}
          {leagues.length > 0 && (
            <div style={{ paddingBottom: '12px', borderBottom: `1px solid ${C.border}` }}>
              <Label>Select League <span style={{ color: C.dim, fontWeight: '400' }}>({leagues.length})</span></Label>
              <input style={{ ...inp, marginBottom: '6px' }} placeholder="Search leagues…" value={leagueSearch} onChange={e => setLeagueSearch(e.target.value)} />
              <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {filteredLeagues.slice(0, 40).map(l => {
                  const name = l.league_name || l.name || `League #${l.league_id}`
                  const isSel = selectedLeague?.league_id === l.league_id
                  return (
                    <div key={l.league_id}
                      onClick={() => selectLeague({ ...l, league_name: name })}
                      style={{ padding: '5px 8px', borderRadius: '3px', cursor: 'pointer', fontSize: '11px', lineHeight: '1.4', transition: 'background 0.1s', background: isSel ? C.accent + '18' : 'transparent', border: `1px solid ${isSel ? C.accent + '55' : 'transparent'}`, color: isSel ? C.accent : C.text }}
                      onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = C.border + '80' }}
                      onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent' }}
                    >
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
                      <div style={{ color: C.dim, fontSize: '9.5px' }}>#{l.league_id}{l.status ? ` · ${l.status}` : ''}{l.tier ? ` · ${l.tier}` : ''}</div>
                    </div>
                  )
                })}
                {filteredLeagues.length === 0 && <div style={{ color: C.dim, fontSize: '10.5px', padding: '6px' }}>No leagues match.</div>}
              </div>
            </div>
          )}

          {/* Team picker */}
          {leagueTeams.length > 0 && (
            <div style={{ paddingBottom: '12px', borderBottom: `1px solid ${C.border}` }}>
              <Label>Teams</Label>
              <span style={{ color: C.muted, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>Our team</span>
              <select style={{ ...inp, borderColor: C.liq + '55', marginBottom: '2px' }} value={ourTeam?.team_id || ''}
                onChange={e => setOurTeam(leagueTeams.find(x => x.team_id === parseInt(e.target.value)) || null)}>
                <option value="">— select —</option>
                {leagueTeams.map(t => <option key={t.team_id} value={t.team_id}>{t.team_name} ({t.wins}W-{t.losses}L)</option>)}
              </select>
              <TeamCard team={ourTeam} color={C.liq} />
              <span style={{ color: C.muted, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', display: 'block', marginBottom: '4px', marginTop: '10px' }}>Opposition</span>
              <select style={{ ...inp, borderColor: C.dire + '55', marginBottom: '2px' }} value={oppTeam?.team_id || ''}
                onChange={e => setOppTeam(leagueTeams.find(x => x.team_id === parseInt(e.target.value)) || null)}>
                <option value="">— select —</option>
                {leagueTeams.filter(t => t.team_id !== ourTeam?.team_id).map(t => <option key={t.team_id} value={t.team_id}>{t.team_name} ({t.wins}W-{t.losses}L)</option>)}
              </select>
              <TeamCard team={oppTeam} color={C.dire} />
            </div>
          )}

          {loadingTeams && <div style={{ color: C.MED, fontSize: '11px', textAlign: 'center' }}>Loading teams…</div>}

          {/* Draft setup */}
          {ourTeam && oppTeam && (
            <div style={{ paddingBottom: '12px', borderBottom: `1px solid ${C.border}` }}>
              <Label>Draft Setup</Label>
              <span style={{ color: C.muted, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>Radiant side</span>
              <select style={{ ...inp, marginBottom: '8px' }} value={radiantSide} onChange={e => setRadiantSide(e.target.value)}>
                <option value="our">Our team ({ourTeam.team_name})</option>
                <option value="opp">Opposition ({oppTeam.team_name})</option>
              </select>
              <span style={{ color: C.muted, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', display: 'block', marginBottom: '4px' }}>First pick</span>
              <select style={{ ...inp }} value={firstPick} onChange={e => setFirstPick(e.target.value)}>
                <option value="our">Our team ({ourTeam.team_name})</option>
                <option value="opp">Opposition ({oppTeam.team_name})</option>
              </select>
            </div>
          )}

          <button style={btn(C.accent, runDisabled)} onClick={runSim} disabled={runDisabled}>
            {appStatus === 'loading' ? 'Simulating…' : '⚡ Run Simulation'}
          </button>
          {!selectedLeague && leagues.length > 0 && <div style={{ color: C.dim, fontSize: '10px', marginTop: '-4px' }}>Select a league to continue.</div>}
          {selectedLeague && leagueTeams.length > 0 && (!ourTeam || !oppTeam) && <div style={{ color: C.dim, fontSize: '10px', marginTop: '-4px' }}>Select both teams to run.</div>}
          {!anthropicKeyOk && (
            <div style={{ color: C.LOW, fontSize: '10px', lineHeight: '1.6', padding: '6px 8px', background: C.LOW + '10', border: `1px solid ${C.LOW}30`, borderRadius: '3px' }}>
              Simulation requires ANTHROPIC_API_KEY in app/.env
            </div>
          )}
        </div>

        {/* Main content */}
        <div style={{ overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Activity log */}
          {logs.length > 0 && (
            <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: '3px', padding: '10px 12px', fontSize: '11px', maxHeight: '130px', overflowY: 'auto', lineHeight: '1.7' }}>
              {logs.map((l, i) => (
                <div key={i} style={{ color: l.includes('Error') ? C.dire : l.includes('✓') ? C.HIGH : C.muted }}>{l}</div>
              ))}
              <div ref={logEnd} />
            </div>
          )}

          {/* Terminal */}
          <div style={{ ...card(), padding: 0 }}>
            <div style={{ padding: '9px 13px', borderBottom: `1px solid ${C.border}` }}>
              <div style={stitle()}>Terminal</div>
              <div style={{ color: C.muted, fontSize: '10.5px', lineHeight: '1.9', minHeight: '40px' }}>
                {cmdHist.length === 0
                  ? <span style={{ color: C.dim }}>/clear · /status · /league &lt;id&gt; · /cache · /cache clear</span>
                  : cmdHist.slice(-8).map((l, i) => <div key={i} style={{ color: l.startsWith('>') ? C.accent : C.muted }}>{l}</div>)
                }
              </div>
            </div>
            <input
              style={{ ...inp, background: 'transparent', border: 'none', borderTop: `1px solid ${C.border}`, color: C.accent, borderRadius: 0, padding: '9px 13px' }}
              placeholder="Enter command…"
              value={cmdVal}
              onChange={e => setCmdVal(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && cmdVal.trim()) { handleCmd(cmdVal.trim()); setCmdVal('') } }}
            />
          </div>

          {/* Match preview */}
          {ourTeam && oppTeam && !results && (
            <div style={card(C.border)}>
              <div style={stitle(C.muted)}>Match Preview</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: '16px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                    {ourTeam.team_logo_src && <img src={ourTeam.team_logo_src} alt="" width={32} height={32} style={{ objectFit: 'contain' }} onError={e => { e.target.style.display = 'none' }} />}
                    <div>
                      <div style={{ color: C.liq, fontWeight: '700', fontSize: '13px' }}>{ourTeam.team_name}</div>
                      <div style={{ color: C.muted, fontSize: '10.5px' }}>{ourTeam.wins}W-{ourTeam.losses}L · {ourTeam.win_rate}</div>
                    </div>
                  </div>
                  <div style={{ color: C.dim, fontSize: '10px' }}>Rating: {ourTeam.average_team_imprint_rating} <span style={{ color: C.muted }}>({ourTeam.rating_label})</span></div>
                  {ourTeam.players?.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ color: C.dim, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '4px' }}>Roster</div>
                      {ourTeam.players.map(p => (
                        <div key={p.account_id} style={{ color: C.muted, fontSize: '10.5px', lineHeight: '1.7' }}>
                          <span style={{ color: C.dim, fontSize: '9.5px', minWidth: '12px', display: 'inline-block' }}>P{p.position}</span>{' '}{p.account_name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: C.border, fontSize: '20px', fontWeight: '800' }}>VS</div>
                  <div style={{ color: C.dim, fontSize: '9px', marginTop: '4px' }}>{selectedLeague?.league_name?.split(' ').slice(0, 3).join(' ')}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', justifyContent: 'flex-end' }}>
                    <div>
                      <div style={{ color: C.dire, fontWeight: '700', fontSize: '13px' }}>{oppTeam.team_name}</div>
                      <div style={{ color: C.muted, fontSize: '10.5px' }}>{oppTeam.wins}W-{oppTeam.losses}L · {oppTeam.win_rate}</div>
                    </div>
                    {oppTeam.team_logo_src && <img src={oppTeam.team_logo_src} alt="" width={32} height={32} style={{ objectFit: 'contain' }} onError={e => { e.target.style.display = 'none' }} />}
                  </div>
                  <div style={{ color: C.dim, fontSize: '10px' }}>Rating: {oppTeam.average_team_imprint_rating} <span style={{ color: C.muted }}>({oppTeam.rating_label})</span></div>
                  {oppTeam.players?.length > 0 && (
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ color: C.dim, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '4px' }}>Roster</div>
                      {oppTeam.players.map(p => (
                        <div key={p.account_id} style={{ color: C.muted, fontSize: '10.5px', lineHeight: '1.7' }}>
                          {p.account_name}{' '}<span style={{ color: C.dim, fontSize: '9.5px' }}>P{p.position}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Results */}
          {results && (
            <>
              {/* Context packet */}
              <div style={card(C.liq + '55')}>
                <div style={{ ...stitle(C.liq), marginBottom: '4px' }}>
                  Context Packet
                  <span style={{ color: C.muted, fontWeight: '400', fontSize: '10px' }}>{results.packet.our_team} vs {results.packet.opposition_team}</span>
                </div>
                <div style={{ color: C.dim, fontSize: '9.5px', marginBottom: '10px' }}>
                  {results.packet.league_name} · {results.packet.league_hero_pool_size} heroes in meta pool
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  {[
                    { label: 'Our team',   prof: results.packet.our_profile,  color: C.liq },
                    { label: 'Opposition', prof: results.packet.opp_profile, color: C.dire },
                  ].map(({ label, prof, color }) => (
                    <div key={label}>
                      <div style={{ color, fontSize: '11px', marginBottom: '7px', fontWeight: '700' }}>
                        {label}: {prof.team_name}
                        <span style={{ color: C.dim, fontWeight: '400', marginLeft: '6px', fontSize: '10px' }}>{prof.record}</span>
                      </div>

                      <div style={{ color: C.dim, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '4px' }}>Identity heroes</div>
                      <div style={{ marginBottom: '6px' }}>
                        {prof.top_identity_heroes?.map(h => <Chip key={h.hero} cls="core">{h.hero} <span style={{ opacity: 0.55 }}>({h.weighted_games}wg)</span></Chip>)}
                        {!prof.top_identity_heroes?.length && <span style={{ color: C.dim, fontSize: '10.5px' }}>—</span>}
                      </div>

                      <div style={{ color: C.dim, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '4px' }}>Comfort picks</div>
                      <div style={{ marginBottom: '6px' }}>
                        {prof.comfort_picks?.slice(0, 5).map(h => <Chip key={h.hero} cls="comfort">{h.hero}</Chip>)}
                        {!prof.comfort_picks?.length && <span style={{ color: C.dim, fontSize: '10.5px' }}>—</span>}
                      </div>

                      {prof.high_ban_targets?.length > 0 && <>
                        <div style={{ color: C.dim, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '4px' }}>High ban targets</div>
                        <div style={{ marginBottom: '6px' }}>
                          {prof.high_ban_targets.map(h => <Chip key={h.hero} cls="high_ban_target">{h.hero} <span style={{ opacity: 0.55 }}>{Math.round(h.ban_pressure * 100)}%</span></Chip>)}
                        </div>
                      </>}

                      <div style={{ color: C.dim, fontSize: '9px', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '4px' }}>Habit picks</div>
                      <div style={{ marginBottom: '6px' }}>
                        {prof.habit_picks?.slice(0, 3).map(h => <Chip key={h.hero} cls="habit">{h.hero}</Chip>)}
                        {!prof.habit_picks?.length && <span style={{ color: C.dim, fontSize: '10.5px' }}>—</span>}
                      </div>

                      {prof.leagues_analysed?.length > 0 && (
                        <div style={{ color: C.dim, fontSize: '9px', marginTop: '4px' }}>
                          {prof.leagues_analysed.map((e, i) => (
                            <span key={e.leagueId} style={{ marginRight: '6px' }}>
                              #{e.leagueId} {e.patch ? `(${e.patch})` : ''} ×{(e.weight ?? 0).toFixed(2)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Ban Intelligence panel */}
                <BanIntelligence ourProfile={results.packet.our_profile} oppProfile={results.packet.opp_profile} />

                <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                  <div>
                    <span style={{ color: C.dim, fontSize: '9px', textTransform: 'uppercase', letterSpacing: '1.5px', display: 'block' }}>Radiant</span>
                    <span style={{ color: C.radiant, fontSize: '12px' }}>{results.packet.radiant_team}</span>
                  </div>
                  <div>
                    <span style={{ color: C.dim, fontSize: '9px', textTransform: 'uppercase', letterSpacing: '1.5px', display: 'block' }}>First pick</span>
                    <span style={{ color: C.green, fontSize: '12px' }}>{results.packet.first_pick_team}</span>
                  </div>
                </div>
              </div>

              {/* Agent outputs */}
              {[
                { key: 'agentA', label: 'Agent A — Draft Order & Priority',  color: C.radiant },
                { key: 'agentB', label: 'Agent B — Our Team Comfort',         color: C.green },
                { key: 'agentC', label: 'Agent C — Opposition Counter-picks', color: C.dire },
                { key: 'agentD', label: 'Agent D — Meta & Tendencies',        color: C.MED },
              ].map(({ key, label, color }) => (
                <details key={key} style={card(color + '35')}>
                  <summary style={{ ...stitle(color), cursor: 'pointer', userSelect: 'none', marginBottom: 0 }}>{label}</summary>
                  <pre style={{ whiteSpace: 'pre-wrap', color: C.text, lineHeight: '1.8', fontSize: '11.5px', margin: '12px 0 0', fontFamily: 'inherit' }}>
                    {results.output[key]}
                  </pre>
                </details>
              ))}

              {/* Lead agent — structured table + strategy */}
              <div style={card(C.accent + '70')}>
                <div style={stitle(C.accent)}>
                  Lead Agent — Final Draft Recommendation
                  {results.output.escalations?.length > 0 && <Bdg color={C.MED}>{results.output.escalations.length} escalated → B</Bdg>}
                  {results.output.parsed?.slots?.length > 0
                    ? <Bdg color={C.HIGH}>{results.output.parsed.slots.length} slots parsed</Bdg>
                    : <Bdg color={C.MED}>raw text</Bdg>}
                </div>

                {results.output.parsed?.slots?.length > 0 ? (
                  <>
                    <DraftTable
                      slots={results.output.parsed.slots}
                      ourTeamName={results.packet.our_team}
                      oppTeamName={results.packet.opposition_team}
                    />
                    {results.output.parsed.strategy && (
                      <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: `1px solid ${C.border}` }}>
                        <div style={{ color: C.accent, fontSize: '9px', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: '6px', fontWeight: '700' }}>Strategy</div>
                        <p style={{ color: C.text, lineHeight: '1.8', fontSize: '11.5px', margin: 0 }}>{results.output.parsed.strategy}</p>
                      </div>
                    )}
                  </>
                ) : (
                  <pre style={{ whiteSpace: 'pre-wrap', color: C.text, lineHeight: '1.8', fontSize: '11.5px', margin: 0, fontFamily: 'inherit' }}>
                    {results.output.lead}
                  </pre>
                )}
              </div>
            </>
          )}

          {/* Idle splash */}
          {appStatus === 'idle' && !results && !ourTeam && (
            <div style={{ color: C.dim, textAlign: 'center', marginTop: '60px', lineHeight: '2.5' }}>
              <div style={{ color: C.accent, fontSize: '22px', fontWeight: '800', letterSpacing: '4px', marginBottom: '10px' }}>DRAFT.AI</div>
              <div style={{ color: C.muted, fontSize: '11.5px' }}>
                1. Load Leagues → select a league<br />
                2. Pick Our Team + Opposition<br />
                3. Set radiant / first-pick → Run Simulation
              </div>
              <div style={{ marginTop: '16px', color: C.dim, fontSize: '10.5px' }}>
                Data: Imprint GG v2 API · Agents: Claude claude-opus-4-5
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
