import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
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

export default defineConfig(() => {
  const fileEnv = parseEnv()
  // process.env wins over .env file (allows CI/shell overrides)
  const IMPRINT_KEY = (process.env.IMPRINT_API_KEY  || fileEnv.IMPRINT_API_KEY  || '').trim()
  const CLAUDE_KEY  = (process.env.ANTHROPIC_API_KEY || fileEnv.ANTHROPIC_API_KEY || '').trim()

  // Startup confirmation
  console.log(`[proxy] Imprint key : ${IMPRINT_KEY ? IMPRINT_KEY.slice(0, 8) + '…' : '❌ MISSING'}`)
  console.log(`[proxy] Anthropic key: ${CLAUDE_KEY  ? CLAUDE_KEY.slice(0, 12)  + '…' : '❌ MISSING — simulation will 401'}`)

  return {
    plugins: [react()],
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
