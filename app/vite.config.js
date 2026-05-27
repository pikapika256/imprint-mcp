import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import fs from 'node:fs/promises'
import { resolve, dirname } from 'path'
import path from 'node:path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Parse .env manually — guarantees we read the file next to this config,
// and strips Windows \r carriage returns that break header injection.
function parseEnv() {
  try {
    const raw = readFileSync(resolve(__dirname, '.env'), 'utf8')
    const result = {}
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+)$/)
      if (m) result[m[1]] = m[2].trim()
    }
    return result
  } catch {
    return {}
  }
}

// ── Notes API Vite plugin ─────────────────────────────────────────────────────
// Serves D:\DotaAI as a local REST API so the React app can read/write vault
// files from the browser without needing a separate backend process.
const VAULT = 'D:\\DotaAI'

function notesApiPlugin() {
  return {
    name: 'notes-api',
    configureServer(server) {
      // Resolve + validate path stays inside vault (prevents traversal attacks)
      function safeJoin(relPath) {
        const abs = path.resolve(VAULT, (relPath || '').replace(/^\/+/, ''))
        if (!abs.startsWith(path.resolve(VAULT))) throw new Error('Path traversal denied')
        return abs
      }

      server.middlewares.use(async (req, res, next) => {
        if (!req.url.startsWith('/api/notes')) { next(); return }

        const url = new URL(req.url, 'http://localhost')
        const method = req.method

        // ── GET /api/notes/list?dir=<relative> ───────────────────────────
        if (method === 'GET' && url.pathname === '/api/notes/list') {
          try {
            const rel = url.searchParams.get('dir') || ''
            const abs = safeJoin(rel)
            const entries = await fs.readdir(abs, { withFileTypes: true })
            const result = entries
              .filter(e => !e.name.startsWith('.'))
              .map(e => ({
                name: e.name,
                type: e.isDirectory() ? 'dir' : 'file',
                path: (rel ? rel + '/' : '') + e.name,
              }))
              .sort((a, b) => {
                if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
                return a.name.localeCompare(b.name)
              })
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } catch (e) {
            res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message }))
          }
          return
        }

        // ── GET /api/notes/read?path=<relative> ──────────────────────────
        if (method === 'GET' && url.pathname === '/api/notes/read') {
          try {
            const rel = url.searchParams.get('path') || ''
            const abs = safeJoin(rel)
            const content = await fs.readFile(abs, 'utf8')
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end(content)
          } catch (e) {
            res.writeHead(e.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message }))
          }
          return
        }

        // ── POST /api/notes/write ────────────────────────────────────────
        // Body: { path: "heroes/axe.md", mode: "append"|"overwrite", content: "..." }
        if (method === 'POST' && url.pathname === '/api/notes/write') {
          let body = ''
          req.on('data', d => { body += d })
          req.on('end', async () => {
            try {
              const { path: rel, mode, content } = JSON.parse(body)
              const abs = safeJoin(rel)
              await fs.mkdir(path.dirname(abs), { recursive: true })
              if (mode === 'append') {
                const existing = await fs.readFile(abs, 'utf8').catch(() => '')
                const sep = existing && !existing.endsWith('\n') ? '\n\n' : (existing ? '\n' : '')
                await fs.writeFile(abs, existing + sep + content, 'utf8')
              } else {
                await fs.writeFile(abs, content, 'utf8')
              }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true, path: rel }))
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: e.message }))
            }
          })
          return
        }

        // ── GET /api/notes/search?q=<term> ───────────────────────────────
        if (method === 'GET' && url.pathname === '/api/notes/search') {
          try {
            const q = (url.searchParams.get('q') || '').toLowerCase()
            const results = []
            async function walk(dir) {
              const entries = await fs.readdir(dir, { withFileTypes: true })
              for (const e of entries) {
                if (e.name.startsWith('.')) continue
                const abs = path.join(dir, e.name)
                if (e.isDirectory()) { await walk(abs); continue }
                if (!e.name.endsWith('.md')) continue
                const rel = path.relative(VAULT, abs).replace(/\\/g, '/')
                if (rel.toLowerCase().includes(q)) { results.push({ path: rel, match: 'filename' }); continue }
                const content = await fs.readFile(abs, 'utf8').catch(() => '')
                if (content.toLowerCase().includes(q)) results.push({ path: rel, match: 'content' })
              }
            }
            await walk(VAULT)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(results.slice(0, 50)))
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message }))
          }
          return
        }

        next()
      })
    },
  }
}

export default defineConfig(() => {
  const fileEnv = parseEnv()
  // process.env wins over .env file (allows CI/shell overrides)
  const IMPRINT_KEY = (process.env.IMPRINT_API_KEY  || fileEnv.IMPRINT_API_KEY  || '').trim()
  const CLAUDE_KEY  = (process.env.ANTHROPIC_API_KEY || fileEnv.ANTHROPIC_API_KEY || '').trim()

  // Startup confirmation
  console.log(`[proxy] Imprint key : ${IMPRINT_KEY ? IMPRINT_KEY.slice(0, 8) + '…' : '❌ MISSING'}`)
  console.log(`[proxy] Anthropic key: ${CLAUDE_KEY  ? CLAUDE_KEY.slice(0, 12)  + '…' : '❌ MISSING — simulation will 401'}`)
  console.log(`[notes] Vault path  : ${VAULT}`)

  return {
    plugins: [react(), notesApiPlugin()],
    server: {
      port: 5173,
      proxy: {
        // ── Imprint GG v2 ────────────────────────────────────────────────
        '/api/imprint': {
          target: 'https://v2.api.imprint.gg',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/imprint/, ''),
          // `headers` is injected into every request Vite forwards to the target
          headers: {
            'x-api-key': IMPRINT_KEY,
            'Accept': 'application/json',
          },
        },

        // ── Anthropic Claude ─────────────────────────────────────────────
        '/api/claude': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/api\/claude/, ''),
          headers: {
            'x-api-key': CLAUDE_KEY,
            'anthropic-version': '2023-06-01',
            // Required when Anthropic detects an Origin header (browser proxied request)
            'anthropic-dangerous-direct-browser-access': 'true',
          },
        },
      },
    },
  }
})
