# Imprint MCP — Project Handoff

**Branch:** `feature/knowledge-base`  
**Last updated:** 2026-05-29  
**Repo:** https://github.com/pikapika256/imprint-mcp

---

## What This Project Is

A Dota 2 draft simulation tool built as a React/Vite web app. It pulls live match data from the [Imprint GG API](https://v2.api.imprint.gg) and uses Claude (Anthropic API) to simulate a five-agent draft panel that produces pick/ban recommendations for professional matches.

A personal knowledge vault (`vault/`) stores expert Dota 2 notes in Markdown. At simulation time, relevant notes are loaded and injected into the agent context, so agents cite both API statistics and personal expert knowledge.

---

## Architecture

```
imprint-mcp/
├── src/                        # MCP server (TypeScript)
│   └── index.ts                # Imprint GG API → MCP tools
├── dist/                       # Compiled MCP server (gitignored)
├── app/                        # React/Vite frontend
│   ├── src/
│   │   └── DraftAI.jsx         # All UI, agents, simulation logic
│   └── vite.config.js          # Dev server + proxy + notes API plugin
├── vault/                      # Personal knowledge base (Markdown)
│   ├── Draft Philosophy.md
│   ├── heroes/                 # 127 hero files
│   ├── items/                  # 55 item files
│   ├── matchups/               # 9 matchup/strategy files
│   ├── patches/                # Patch notes + tournament stats
│   └── positions/              # pos1–pos5 meta notes
└── .mcp.json                   # MCP server config (gitignored — contains API keys)
```

---

## How to Run

### Prerequisites
- Node.js
- API keys in `app/.env`:
  ```
  IMPRINT_API_KEY=your_key
  ANTHROPIC_API_KEY=your_key
  ```
- `.mcp.json` at repo root (see `.mcp.json.example`)

### Start the app
```bash
cd app
npm install
npm run dev
```
Opens at `http://localhost:5173`. The Vite dev server proxies Imprint and Anthropic API calls and serves the vault via `/api/notes/*`.

### MCP server (for Claude Code integration)
```bash
npm install
npm run build
```
The `.mcp.json` registers two MCP servers: `imprint-dota2` (match data) and `filesystem` (vault access).

---

## Key Files

### `app/src/DraftAI.jsx`
The entire application. Key sections:
- **`PATCH_WINDOWS`** — maps calendar dates to patch versions (currently covers 7.35–7.41)
- **`loadRelevantNotes()`** — loads vault notes pre-simulation with a 10,000 char budget. Priority order: Draft Philosophy → patch notes → teams → players → heroes → matchups → positions → items
- **`buildContextPacket()`** — assembles all API data + expert knowledge into the JSON context passed to agents
- **`runSim()`** — orchestrates the full simulation: fetches hero stats, loads notes, runs 5 agents in sequence
- **Five agents:**
  - `SYS.a` — hero stats analyst
  - `SYS.b` — our team analyst (player tendencies + hero pool)
  - `SYS.c` — opponent analyst (counter-picking)
  - `SYS.d` — meta analyst (patch context + web search)
  - `SYS.lead` — draft lead (produces final pick/ban output)
- **Knowledge tab** — in-app chat for capturing notes to vault; Claude emits `SAVE_NOTE: <path> | <mode> | <content>` directives that write to the vault automatically
- **`SYS.knowledge_chat`** — prompt for the knowledge assistant

### `app/vite.config.js`
- **`notesApiPlugin()`** — inline Vite plugin serving 4 REST endpoints:
  - `GET /api/notes/list?dir=<rel>` — list files
  - `GET /api/notes/read?path=<rel>` — read file
  - `POST /api/notes/write` — write/append (auto-creates dirs)
  - `GET /api/notes/search?q=<term>` — recursive search
- **`VAULT`** — resolves to `vault/` relative to repo root
- API proxies: `/api/imprint` → Imprint GG, `/api/claude` → Anthropic

---

## Vault Knowledge Base

The vault is an Obsidian-compatible Markdown knowledge base. All notes follow this convention:
- Lowercase filenames with underscores (`phantom_assassin.md`)
- Timestamped entries: `> [YYYY-MM-DD]: CATEGORY -- content`

### Current Coverage

| Area | Files | Status |
|------|-------|--------|
| Heroes | 127 | All heroes from DreamLeague S29 have notes; ~80 additional stubs |
| Items | 55 | Key meta items documented; others are stubs |
| Matchups | 9 | Mid pool matrix (105 pairings), key matchup strategies |
| Patches | 5 | 7.38–7.41 patch notes + DreamLeague S29 tournament stats |
| Positions | 5 | pos1–pos5 meta roles |
| Draft Philosophy | 1 | Pick order theory, composition balance, BKB considerations |

### Mid Pool Matchup Matrix
`vault/matchups/mid_pool_matrix.md` — 105 laning matchup win splits for the 15 most common mid heroes in 7.41c. Includes a tier framework for assigning approximate splits to unlisted heroes.

### Hero Coverage Highlights
- **Fully documented:** All pos 2 mid pool heroes (15), all top pos 3/4/5 heroes, all heroes appearing in DreamLeague S29
- **Key notes:** Huskar/Viper as lane bullies, creep drag strategy (melee mids), Kez as new S-tier hero, Bane as undervalued support (68.8% WR, 2 bans)
- **Agent citations:** Notes are cited with `[PN: filename]` in agent output; conflicts with API data are flagged as `CONFLICT: API shows X but personal note says Y`

---

## In-App Knowledge Capture

The Knowledge Base tab (top-right of the app) allows conversational note entry:

1. Type an observation (e.g. "Axe is strong in the current patch against high HP carries")
2. Claude categorises it, determines the correct file path, and outputs a `SAVE_NOTE` directive
3. The note is written to `vault/` automatically and reflected in the note browser

**File path conventions:**
- `heroes/<hero_name>.md`
- `matchups/<hero_a>_vs_<hero_b>.md`
- `positions/pos<1-5>.md`
- `players/<account_name>.md` *(for personal player tendencies)*
- `teams/<team_name>.md`
- `items/<item_name>.md`
- `patches/<version>.md`
- `Draft Philosophy.md`

---

## Open Items / Next Steps

### Code
- [ ] **Merge `feature/knowledge-base` to `main`** — PR open at https://github.com/pikapika256/imprint-mcp/pull/1
- [ ] **Obsidian sync** — vault is now in `vault/` in the repo; if Obsidian is still pointing to `D:\DotaAI`, update the vault path in Obsidian settings to `C:\...\imprint-mcp\vault`
- [ ] **`.mcp.json` portability** — currently uses absolute paths for the Node.js executable; update `.mcp.json.example` with relative paths or `node` for other contributors
- [ ] **CRLF normalisation** — add `.gitattributes` to enforce `* text=auto` and avoid LF→CRLF warnings on every commit

### Knowledge Base
- [ ] **Team-specific tendencies** — `teams/` directory is empty; populate with known team draft styles (e.g. Team Liquid, Team Spirit, Tundra, Xtreme Gaming tendencies)
- [ ] **Player notes** — `players/` directory is empty; populate with pro player hero preferences and tendencies for tournament prep
- [ ] **Ringmaster** — new hero, needs full notes
- [ ] **Naga Siren support role** — noted as emerging support pick, needs deeper notes
- [ ] **Items expansion** — ~30 item stubs have no notes; populate as matchup relevance arises
- [ ] **Mid pool matrix expansion** — add new heroes as they appear in future tournaments per the protocol in `mid_pool_matrix.md`
- [ ] **7.41c sub-patch tracking** — if 7.41d/e patches release, update `patches/` and hero notes accordingly

### Simulation
- [ ] **Test knowledge injection** — verify `expert_knowledge` appears in agent output with `[PN: ...]` citations after vault is populated
- [ ] **Token budget tuning** — current budget is 10,000 chars; may need adjustment based on context window usage
- [ ] **`loadRelevantNotes` hero name matching** — hero names from API (`raw_name`) should be slugified to match vault filenames; verify `slugify()` handles all edge cases

---

## Configuration Reference

| Setting | Location | Notes |
|---------|----------|-------|
| Imprint API key | `app/.env` → `IMPRINT_API_KEY` | Also in `.mcp.json` for Claude Code |
| Anthropic API key | `app/.env` → `ANTHROPIC_API_KEY` | |
| Vault path | `app/vite.config.js` → `VAULT` | Auto-resolves to `vault/` relative to repo |
| MCP filesystem path | `.mcp.json` → `filesystem.args[1]` | Should point to `vault/` |
| Vite port | `app/vite.config.js` → `server.port` | Default 5173 |
