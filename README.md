# imprint-dota2 MCP Server

Connects Claude to `https://v2.api.imprint.gg` for Dota 2 league, series, and match draft data.
Built against the official docs at https://docs.api.imprint.gg.

---

## Setup

### 1. Install and build

```bash
cd imprint-mcp
npm install
npm run build
```

### 2. Register with Claude Desktop

Edit your Claude Desktop config:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "imprint-dota2": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/imprint-mcp/dist/index.js"],
      "env": {
        "IMPRINT_API_KEY": "your_imprint_api_key_here"
      }
    }
  }
}
```

Restart Claude Desktop — the tools appear automatically.

---

## Typical workflow for draft analysis

```
1. queue_league(league_id)          ← first time only; queues all matches for processing
2. get_league_fixtures(league_id)   ← find Liquid series, get imprint_series_id + match_ids
3. get_series(series_id)            ← overview of all games in a series
4. get_match(match_id)              ← full draft (#1-#24) + player stats for one game
```

For hero winrate summaries without per-game detail:
```
get_league_team_heroes(league_id, team_id=2163)   ← Liquid hero stats for the tournament
get_league_hero_stats(league_id)                  ← all heroes across all teams
```

---

## Tools reference

| Tool | Method | Endpoint | Description |
|------|--------|----------|-------------|
| `queue_league` | POST | `/queue/league` | Queue all matches in a league for processing |
| `queue_match` | POST | `/queue/match` | Queue a single match for processing |
| `get_league_matches` | GET | `/league/{id}/matches` | All series + match IDs in a league |
| `get_league_fixtures` | GET | `/league/{id}/fixtures` | All fixtures with teams, scores, timestamps |
| `get_league_teams` | GET | `/league/{id}/teams` | All teams + W/L in a league |
| `get_league_hero_stats` | GET | `/league/{id}/heroes` | Hero pick/win/loss/winrate across whole league |
| `get_league_team_heroes` | GET | `/league/{id}/team/{id}/heroes` | Hero stats for one team |
| `get_league_team_stats` | GET | `/league/{id}/team/{id}/statistics` | Team performance summary |
| `get_series` | GET | `/series/{id}` | Full series (accepts series_id or imprint_series_id) |
| `get_match` | GET | `/match/{id}` | Full match: draft array, player stats, items, timelines |

---

## Draft array structure (from get_match)

```json
{
  "action_number": 1,
  "is_pick": false,
  "is_radiant_action": true,
  "phase": "FIRST_BAN",
  "hero": { "name": "Jakiro", "id": 64, "raw_name": "npc_dota_hero_jakiro" }
}
```

Phases in order: FIRST_BAN -> FIRST_PICK -> SECOND_BAN -> SECOND_PICK -> THIRD_BAN -> THIRD_PICK

Action numbers 1-24 map directly to Dota 2 Captains Mode draft order.
First-acting team = the team whose is_radiant_action matches action #1.

---

## Key IDs

| Entity | ID |
|--------|----|
| Team Liquid | 2163 |
| PGL Wallachia Season 8 | 19543 |
| BLAST Slam VI | 19099 |
| ESL One Birmingham 2026 | 19422 |
| DreamLeague Season 28 | 19269 |

---

## Notes

- Auth header is `x-api-key` (not `Authorization: Bearer`).
- Data must be queued before querying — run `queue_league` once per tournament.
- `get_match` returns HTTP 202 if the match is still being processed (retry after a few minutes).
- Prefer `imprint_series_id` (UUID) over `series_id` (Valve int) — it exists before a series starts.
