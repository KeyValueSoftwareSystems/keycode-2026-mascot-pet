#!/usr/bin/env node
/**
 * Local broadcast manifest server, for developing and proving P4 without a hosted file.
 *
 *   pnpm manifest:serve            # serves manifest/manifest.json on http://127.0.0.1:8787
 *   pnpm manifest:serve --port 9000
 *
 * Then run the app with:
 *
 *   KEYCODE_PET_MANIFEST_URL=http://127.0.0.1:8787/manifest.json \
 *   KEYCODE_PET_ALLOW_INSECURE_MANIFEST=1 \
 *   KEYCODE_PET_POLL_MINUTES=1 pnpm dev
 *
 * Loopback HTTP is gated on TWO independent conditions — the env flag above *and* `!app.isPackaged` —
 * so a packaged build cannot be talked into accepting it even with the flag set. See url-guard.ts.
 *
 * Fault injection, so every negative path in the spec can actually be exercised:
 *
 *   ?fault=500        HTTP 500
 *   ?fault=404        HTTP 404
 *   ?fault=slow       never responds (tests the timeout)
 *   ?fault=truncate   declares a length and then closes mid-body
 *   ?fault=oversize   a body larger than the 64KB cap
 *   ?fault=badjson    valid HTTP, invalid JSON
 *   ?fault=redirect   302 to an http:// host (must be refused as a downgrade)
 *   ?fault=loop       302 to itself (must be refused after the hop limit)
 *   ?fault=badutf8    invalid UTF-8 bytes
 */

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const MANIFEST = join(ROOT, 'manifest', 'manifest.json')

function port() {
  const at = process.argv.indexOf('--port')
  if (at === -1) return 8787
  const value = Number(process.argv[at + 1])
  return Number.isFinite(value) && value > 0 ? value : 8787
}

function readManifest() {
  if (!existsSync(MANIFEST)) {
    return { body: JSON.stringify({ version: 1, notifications: [] }), missing: true }
  }
  // Re-read per request, so editing the file is immediately visible to a running client — which is
  // the whole point of this server during development.
  return { body: readFileSync(MANIFEST, 'utf8'), missing: false }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  const fault = url.searchParams.get('fault')

  const log = (note) =>
    console.log(`  ${request.method} ${url.pathname}${url.search} -> ${note}`)

  switch (fault) {
    case 'slow':
      log('hanging (never responds)')
      return // deliberately leave the socket open

    case '500':
      log('500')
      response.writeHead(500).end('internal error')
      return

    case '404':
      log('404')
      response.writeHead(404).end('not found')
      return

    case 'truncate': {
      log('truncated body')
      const body = readManifest().body
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      })
      response.write(body.slice(0, Math.floor(body.length / 2)))
      response.destroy()
      return
    }

    case 'oversize': {
      log('oversize body')
      response.writeHead(200, { 'content-type': 'application/json' })
      // Streamed without a content-length so the *streaming* cap is what stops it, not the header
      // check — that is the path worth exercising.
      const chunk = 'x'.repeat(8 * 1024)
      for (let i = 0; i < 20; i += 1) response.write(chunk)
      response.end()
      return
    }

    case 'badjson':
      log('invalid JSON')
      response.writeHead(200, { 'content-type': 'application/json' }).end('{ not json at all')
      return

    case 'badutf8':
      log('invalid UTF-8')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
      return

    case 'redirect':
      log('302 -> http://example.invalid (scheme downgrade)')
      response.writeHead(302, { location: 'http://example.invalid/manifest.json' }).end()
      return

    case 'loop':
      log('302 -> itself')
      response.writeHead(302, { location: `${url.pathname}?fault=loop` }).end()
      return

    default:
      break
  }

  const { body, missing } = readManifest()
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`

  if (request.headers['if-none-match'] === etag) {
    log('304 not modified')
    response.writeHead(304, { etag }).end()
    return
  }

  log(missing ? '200 (empty fallback: manifest/manifest.json is missing)' : '200')
  response
    .writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      etag,
      'cache-control': 'no-cache',
    })
    .end(body)
})

const chosen = port()
server.listen(chosen, '127.0.0.1', () => {
  console.log(`Broadcast manifest server on http://127.0.0.1:${chosen}/manifest.json`)
  console.log(`Serving ${MANIFEST}, re-read on every request.\n`)
  console.log('Point the app at it with:')
  console.log(`  KEYCODE_PET_MANIFEST_URL=http://127.0.0.1:${chosen}/manifest.json \\`)
  console.log('  KEYCODE_PET_ALLOW_INSECURE_MANIFEST=1 \\')
  console.log('  KEYCODE_PET_POLL_MINUTES=1 pnpm dev\n')
  console.log('Fault injection: ?fault=500|404|slow|truncate|oversize|badjson|badutf8|redirect|loop\n')
})
