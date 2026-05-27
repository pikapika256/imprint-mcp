#!/usr/bin/env node
/**
 * MCP Server — imprint.gg Dota 2 API v2
 * Built against: https://docs.api.imprint.gg
 *
 * Auth:  x-api-key header — set IMPRINT_API_KEY env var
 *
 * Tools:
 *   queue_league            POST /queue/league
 *   queue_match             POST /queue/match
 *   get_league_matches      GET  /league/{league_id}/matches
 *   get_league_fixtures     GET  /league/{league_id}/fixtures
 *   get_league_teams        GET  /league/{league_id}/teams
 *   get_league_hero_stats   GET  /league/{league_id}/heroes
 *   get_league_team_heroes  GET  /league/{league_id}/team/{team_id}/heroes
 *   get_league_team_stats   GET  /league/{league_id}/team/{team_id}/statistics
 *   get_series              GET  /series/{series_id}
 *   get_match               GET  /match/{match_id}
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE = "https://v2.api.imprint.gg";
const API_KEY = process.env.IMPRINT_API_KEY ?? "";

if (!API_KEY) {
  console.error("Warning: IMPRINT_API_KEY is not set — all requests will return 403.");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return {
    "x-api-key": API_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} GET ${path}: ${text}`);
  return JSON.parse(text);
}

async function apiPost(path: string, payload: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} POST ${path}: ${text}`);
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  // ── Queue ──────────────────────────────────────────────────────────────
  {
    name: "queue_league",
    description:
      "Queue all matches from a Dota 2 league for processing by imprint.gg. " +
      "Run this once for a new league before querying match data. " +
      "league_id is the Valve-assigned league ID (e.g. 19543 for PGL Wallachia S8). " +
      "Returns the number of matches queued. Processing is async — wait a few minutes before fetching match data.",
    inputSchema: {
      type: "object",
      properties: {
        league_id: { type: "integer", description: "Valve Dota 2 league ID" },
      },
      required: ["league_id"],
    },
  },
  {
    name: "queue_match",
    description:
      "Queue a single Dota 2 match for processing. Use when a specific match is missing from the database. " +
      "Processing is async — call get_match after a few minutes.",
    inputSchema: {
      type: "object",
      properties: {
        match_id: { type: "integer", description: "Valve Dota 2 match ID" },
      },
      required: ["match_id"],
    },
  },

  // ── League ─────────────────────────────────────────────────────────────
  {
    name: "get_league_matches",
    description:
      "Get all series and match IDs for a league. Each series object contains team names " +
      "and an array of match_ids. Use this to find match IDs, then call get_match for draft details. " +
      "Team Liquid's team_id is 2163.",
    inputSchema: {
      type: "object",
      properties: {
        league_id: { type: "integer", description: "Valve Dota 2 league ID" },
      },
      required: ["league_id"],
    },
  },
  {
    name: "get_league_fixtures",
    description:
      "Get all fixtures (series) for a league — teams, scores, match IDs, timestamps, " +
      "series type (bo1/bo3/bo5), and stage. Includes imprint_series_id (UUID) for stable series lookups. " +
      "Sorted: upcoming first (chronological), then completed (most recent first).",
    inputSchema: {
      type: "object",
      properties: {
        league_id: { type: "integer", description: "Valve Dota 2 league ID" },
      },
      required: ["league_id"],
    },
  },
  {
    name: "get_league_teams",
    description: "Get all teams in a league with their win/loss records.",
    inputSchema: {
      type: "object",
      properties: {
        league_id: { type: "integer", description: "Valve Dota 2 league ID" },
      },
      required: ["league_id"],
    },
  },
  {
    name: "get_league_hero_stats",
    description:
      "Aggregated hero statistics for every hero played in a league — picks, wins, losses, " +
      "win rate, average KDA/GPM/XPM/damage, and Imprint rating. Sorted by most played.",
    inputSchema: {
      type: "object",
      properties: {
        league_id: { type: "integer", description: "Valve Dota 2 league ID" },
      },
      required: ["league_id"],
    },
  },
  {
    name: "get_league_team_heroes",
    description:
      "Hero statistics scoped to one team within a league — picks, wins, losses, win rate, " +
      "average stats, position breakdown, and facet breakdown. Team Liquid = team_id 2163.",
    inputSchema: {
      type: "object",
      properties: {
        league_id: { type: "integer", description: "Valve Dota 2 league ID" },
        team_id: {
          type: "integer",
          description: "Valve Dota 2 team ID. Team Liquid = 2163",
        },
      },
      required: ["league_id", "team_id"],
    },
  },
  {
    name: "get_league_team_stats",
    description:
      "Overall team performance statistics in a league — win rate, average kills, " +
      "average game duration, and Imprint rating. Team Liquid = team_id 2163.",
    inputSchema: {
      type: "object",
      properties: {
        league_id: { type: "integer", description: "Valve Dota 2 league ID" },
        team_id: {
          type: "integer",
          description: "Valve Dota 2 team ID. Team Liquid = 2163",
        },
      },
      required: ["league_id", "team_id"],
    },
  },

  // ── Series ─────────────────────────────────────────────────────────────
  {
    name: "get_series",
    description:
      "Get full data for a series (bo3, bo5, etc.) — both teams, per-match results, " +
      "player heroes, KDA, and Imprint ratings per match. " +
      "Accepts Valve series_id (integer) OR imprint_series_id (UUID from get_league_fixtures). " +
      "Good for getting a quick overview of all games before drilling into individual match drafts.",
    inputSchema: {
      type: "object",
      properties: {
        series_id: {
          type: "string",
          description:
            "Valve series_id (integer as string) OR imprint_series_id (UUID e.g. '3f78836f-be8c-4378-a6f6-b979f43748ca')",
        },
      },
      required: ["series_id"],
    },
  },

  // ── Match ──────────────────────────────────────────────────────────────
  {
    name: "get_match",
    description:
      "Get complete data for a single Dota 2 match. This is the primary endpoint for draft analysis.\n\n" +
      "DRAFT ARRAY: Each object has:\n" +
      "  • action_number (1–24) — draft order position\n" +
      "  • is_pick (true = pick, false = ban)\n" +
      "  • is_radiant_action (true = radiant team's action)\n" +
      "  • phase: FIRST_BAN | FIRST_PICK | SECOND_BAN | SECOND_PICK | THIRD_BAN | THIRD_PICK\n" +
      "  • hero.name, hero.id, hero.raw_name, hero.icon_src\n\n" +
      "TEAMS ARRAY: team_name, team_id, is_radiant, win, kills, players[]\n\n" +
      "PLAYERS: hero, position (1=carry/2=mid/3=off/4=soft sup/5=hard sup), KDA, GPM, XPM, " +
      "net_worth, hero_damage, imprint_rating, end_items, item_timeline, ability_timeline\n\n" +
      "META: duration, timestamp, league_id, series_id, radiant_net_worth_lead[], radiant_xp_lead[]",
    inputSchema: {
      type: "object",
      properties: {
        match_id: { type: "integer", description: "Valve Dota 2 match ID" },
      },
      required: ["match_id"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

async function handleTool(name: string, args: Args): Promise<string> {
  switch (name) {

    case "queue_league":
      return JSON.stringify(
        await apiPost("/queue/league", { league_id: args.league_id }),
        null, 2
      );

    case "queue_match":
      return JSON.stringify(
        await apiPost("/queue/match", { match_id: args.match_id }),
        null, 2
      );

    case "get_league_matches":
      return JSON.stringify(
        await apiGet(`/league/${args.league_id}/matches`),
        null, 2
      );

    case "get_league_fixtures":
      return JSON.stringify(
        await apiGet(`/league/${args.league_id}/fixtures`),
        null, 2
      );

    case "get_league_teams":
      return JSON.stringify(
        await apiGet(`/league/${args.league_id}/teams`),
        null, 2
      );

    case "get_league_hero_stats":
      return JSON.stringify(
        await apiGet(`/league/${args.league_id}/heroes`),
        null, 2
      );

    case "get_league_team_heroes":
      return JSON.stringify(
        await apiGet(`/league/${args.league_id}/team/${args.team_id}/heroes`),
        null, 2
      );

    case "get_league_team_stats":
      return JSON.stringify(
        await apiGet(`/league/${args.league_id}/team/${args.team_id}/statistics`),
        null, 2
      );

    case "get_series":
      return JSON.stringify(
        await apiGet(`/series/${args.series_id}`),
        null, 2
      );

    case "get_match":
      return JSON.stringify(
        await apiGet(`/match/${args.match_id}`),
        null, 2
      );

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP server bootstrap
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "imprint-dota2", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    const result = await handleTool(name, args as Args);
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("imprint-dota2 MCP server v2 running");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
