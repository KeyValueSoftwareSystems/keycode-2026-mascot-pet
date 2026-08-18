import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { getCapped, postCapped, type CappedFetch } from '../../apps/desktop/src/broadcast/http-capped.js'
import { assertAllowedUrl, safeUrl, UnsafeUrlError } from '../../apps/desktop/src/broadcast/url-guard.js'
import { MANIFEST_MAX_BYTES } from '../../apps/desktop/src/config/constants.js'

/**
 * Tested against a real loopback HTTP server rather than a mocked fetch.
 *
 * The behaviours that matter here — a stream cancelled mid-body, a socket closed early, a redirect
 * chain, invalid UTF-8 bytes on the wire — are exactly the ones a hand-written fake gets wrong in the
 * same direction as the code under test.
 */

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1`)
    switch (url.pathname) {
      case '/ok':
        response
          .writeHead(200, { 'content-type': 'application/json', etag: '"abc123"' })
          .end('{"version":1}')
        return

      case '/etag':
        if (request.headers['if-none-match'] === '"abc123"') {
          response.writeHead(304, { etag: '"abc123"' }).end()
          return
        }
        response.writeHead(200, { etag: '"abc123"' }).end('{"version":1}')
        return

      case '/500':
        response.writeHead(500).end('boom')
        return

      case '/404':
        response.writeHead(404).end('nope')
        return

      case '/hang':
        // Never responds. The client's own timeout has to end this.
        return

      case '/declared-oversize':
        response
          .writeHead(200, { 'content-length': String(MANIFEST_MAX_BYTES + 1_000) })
          .end('x'.repeat(10))
        return

      case '/streamed-oversize': {
        // No content-length, so only the streaming cap can stop it.
        response.writeHead(200, { 'content-type': 'application/json' })
        const chunk = 'x'.repeat(8 * 1024)
        for (let i = 0; i < 20; i += 1) response.write(chunk)
        response.end()
        return
      }

      case '/truncated':
        response.writeHead(200, { 'content-length': '1000' })
        response.write('{"version"')
        response.destroy()
        return

      case '/badjson':
        response.writeHead(200).end('{ not json')
        return

      case '/badutf8':
        response.writeHead(200)
        response.end(Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
        return

      case '/redirect-https':
        response.writeHead(302, { location: '/ok' }).end()
        return

      case '/redirect-downgrade':
        // The case a `redirect: 'follow'` implementation would follow silently.
        response.writeHead(302, { location: 'http://example.invalid/x' }).end()
        return

      case '/redirect-loop':
        response.writeHead(302, { location: '/redirect-loop' }).end()
        return

      case '/redirect-nowhere':
        response.writeHead(302).end()
        return

      case '/echo': {
        // Reads the request back so a test can prove the method, content-type and body arrived.
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              method: request.method,
              contentType: request.headers['content-type'] ?? null,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        })
        return
      }

      default:
        response.writeHead(404).end()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const realFetch = globalThis.fetch as CappedFetch

function options(overrides: Partial<Parameters<typeof getCapped>[1]> = {}) {
  return {
    etag: null,
    timeoutMs: 2_000,
    maxBytes: MANIFEST_MAX_BYTES,
    // Loopback HTTP is permitted here because that is exactly what the dev-server path allows.
    allowLoopbackHttp: true,
    maxRedirects: 3,
    ...overrides,
  }
}

describe('getCapped', () => {
  it('returns the body and etag for 200', async () => {
    const result = await getCapped(`${base}/ok`, options(), { fetch: realFetch })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.body).toBe('{"version":1}')
      expect(result.etag).toBe('"abc123"')
    }
  })

  it('returns not-modified when the server honours If-None-Match', async () => {
    const result = await getCapped(`${base}/etag`, options({ etag: '"abc123"' }), { fetch: realFetch })
    expect(result.kind).toBe('not-modified')
  })

  it('reports a status error for 500 and 404', async () => {
    for (const [path, status] of [['/500', 500], ['/404', 404]] as const) {
      const result = await getCapped(`${base}${path}`, options(), { fetch: realFetch })
      expect(result).toMatchObject({ kind: 'error', reason: 'status', status })
    }
  })

  it('times out on a server that never responds', async () => {
    const result = await getCapped(`${base}/hang`, options({ timeoutMs: 300 }), { fetch: realFetch })
    expect(result).toMatchObject({ kind: 'error', reason: 'timeout' })
  })

  it('refuses an oversize body from its declared content-length, without reading it', async () => {
    const result = await getCapped(`${base}/declared-oversize`, options(), { fetch: realFetch })
    expect(result).toMatchObject({ kind: 'error', reason: 'too-large' })
    if (result.kind === 'error') expect(result.detail).toContain('content-length')
  })

  it('cancels a streamed body once it passes the cap', async () => {
    // No content-length, so this exercises the streaming cap — the path that stops a server answering
    // a 64KB request with a gigabyte from exhausting memory.
    const result = await getCapped(`${base}/streamed-oversize`, options({ maxBytes: 32 * 1024 }), {
      fetch: realFetch,
    })
    expect(result).toMatchObject({ kind: 'error', reason: 'too-large' })
  })

  it('reports a network error when the socket closes mid-body', async () => {
    const result = await getCapped(`${base}/truncated`, options(), { fetch: realFetch })
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(['network', 'decode']).toContain(result.reason)
  })

  it('returns invalid JSON as a successful body — parsing is the caller’s job', async () => {
    // Deliberate separation of concerns: transport reports transport failures, and the schema layer
    // decides whether the bytes are usable.
    const result = await getCapped(`${base}/badjson`, options(), { fetch: realFetch })
    expect(result.kind).toBe('ok')
  })

  it('reports a decode error for invalid UTF-8', async () => {
    const result = await getCapped(`${base}/badutf8`, options(), { fetch: realFetch })
    expect(result).toMatchObject({ kind: 'error', reason: 'decode' })
  })

  it('follows a same-origin redirect', async () => {
    const result = await getCapped(`${base}/redirect-https`, options(), { fetch: realFetch })
    expect(result.kind).toBe('ok')
  })

  it('REFUSES a redirect that downgrades the scheme', async () => {
    // The gap openpets leaves open. With `redirect: 'follow'` the HTTPS-only rule would apply only to
    // the URL we asked for, and this hop would be taken silently.
    // Loopback stays permitted so the *initial* request is allowed — otherwise the URL is refused
    // before any redirect happens and this would pass for the wrong reason. The redirect target is
    // http to a NON-loopback host, which the per-hop re-validation must reject.
    const result = await getCapped(`${base}/redirect-downgrade`, options(), { fetch: realFetch })
    expect(result).toMatchObject({ kind: 'error', reason: 'redirect' })
    if (result.kind === 'error') expect(result.detail).toContain('unsafe redirect target')
  })

  it('gives up on a redirect loop after the hop limit', async () => {
    const result = await getCapped(`${base}/redirect-loop`, options({ maxRedirects: 3 }), {
      fetch: realFetch,
    })
    expect(result).toMatchObject({ kind: 'error', reason: 'redirect' })
    if (result.kind === 'error') expect(result.detail).toContain('too many redirects')
  })

  it('reports a redirect with no location as an error', async () => {
    const result = await getCapped(`${base}/redirect-nowhere`, options(), { fetch: realFetch })
    expect(result).toMatchObject({ kind: 'error', reason: 'redirect' })
  })

  it('reports a network error for a closed port', async () => {
    const result = await getCapped('http://127.0.0.1:1/nothing', options({ timeoutMs: 1_500 }), {
      fetch: realFetch,
    })
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(['network', 'timeout']).toContain(result.reason)
  })

  it('refuses a non-HTTPS URL when loopback is not permitted', async () => {
    const result = await getCapped(`${base}/ok`, options({ allowLoopbackHttp: false }), {
      fetch: realFetch,
    })
    expect(result).toMatchObject({ kind: 'error', reason: 'scheme' })
  })

  it('never rejects, whatever the fetch does', async () => {
    // The property the poller depends on: a network problem must be incapable of crashing the pet.
    const hostile: CappedFetch = async () => {
      throw new Error('catastrophic')
    }
    await expect(getCapped(`${base}/ok`, options(), { fetch: hostile })).resolves.toMatchObject({
      kind: 'error',
    })

    const nonsense: CappedFetch = async () => ({}) as unknown as Response
    await expect(getCapped(`${base}/ok`, options(), { fetch: nonsense })).resolves.toMatchObject({
      kind: 'error',
    })
  })
})

describe('url guard', () => {
  it('allows https unconditionally', () => {
    expect(assertAllowedUrl('https://example.com/x').protocol).toBe('https:')
  })

  it('allows loopback http only when explicitly permitted', () => {
    expect(safeUrl('http://127.0.0.1:8787/m.json', { allowLoopbackHttp: true })).not.toBeNull()
    expect(safeUrl('http://localhost:8787/m.json', { allowLoopbackHttp: true })).not.toBeNull()
    expect(safeUrl('http://127.0.0.1:8787/m.json')).toBeNull()
  })

  it('refuses http to a non-loopback host even with the dev flag set', () => {
    // The flag is a dev-server escape hatch, not a general "allow http" switch.
    expect(safeUrl('http://example.com/x', { allowLoopbackHttp: true })).toBeNull()
    expect(safeUrl('http://192.168.1.10/x', { allowLoopbackHttp: true })).toBeNull()
  })

  it('refuses every other scheme', () => {
    for (const url of [
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'ws://example.com',
      'ftp://example.com',
      'smb://share/x',
      'custom-app://do-something',
    ]) {
      expect(safeUrl(url), url).toBeNull()
    }
  })

  it('refuses a protocol-relative URL', () => {
    // Inherits the scheme of the page it came from — and there is no page here.
    expect(safeUrl('//example.com/x')).toBeNull()
  })

  it('refuses nothing-like input', () => {
    for (const value of [null, undefined, '', 42, {}, [], 'not a url']) {
      expect(safeUrl(value as unknown)).toBeNull()
    }
  })

  it('throws a typed error with a machine-readable reason', () => {
    try {
      assertAllowedUrl('file:///x')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeUrlError)
      expect((error as UnsafeUrlError).reason).toBe('forbidden-scheme')
    }
  })
})

describe('postCapped', () => {
  function postOptions(overrides: Partial<Parameters<typeof postCapped>[1]> = {}) {
    return {
      body: '{"hello":"world"}',
      timeoutMs: 2_000,
      maxBytes: MANIFEST_MAX_BYTES,
      allowLoopbackHttp: true,
      ...overrides,
    }
  }

  it('sends the body as JSON and reports success', async () => {
    const result = await postCapped(`${base}/echo`, postOptions(), { fetch: realFetch })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const echoed = JSON.parse(result.body) as {
      method: string
      contentType: string | null
      body: string
    }
    expect(echoed.method).toBe('POST')
    expect(echoed.contentType).toBe('application/json')
    expect(echoed.body).toBe('{"hello":"world"}')
  })

  it('REFUSES a redirect instead of following it', async () => {
    // The whole point of the divergence from getCapped: re-sending a payload to a host the server
    // picked is not a thing worth doing for analytics.
    const result = await postCapped(`${base}/redirect-https`, postOptions(), { fetch: realFetch })

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('redirect')
  })

  it('refuses a non-HTTPS URL when loopback is not permitted', async () => {
    const result = await postCapped(
      `${base}/echo`,
      postOptions({ allowLoopbackHttp: false }),
      { fetch: realFetch },
    )

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('scheme')
  })

  it('reports a server error by status rather than throwing', async () => {
    const result = await postCapped(`${base}/500`, postOptions(), { fetch: realFetch })

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('status')
    expect(result.status).toBe(500)
  })

  it('gives up on a server that never answers', async () => {
    const result = await postCapped(
      `${base}/hang`,
      postOptions({ timeoutMs: 150 }),
      { fetch: realFetch },
    )

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('timeout')
  })

  it('never rejects, whatever the fetch does', async () => {
    const throwing: CappedFetch = () => Promise.reject(new Error('socket exploded'))
    const result = await postCapped('https://example.invalid/x', postOptions(), { fetch: throwing })

    expect(result.kind).toBe('error')
    if (result.kind !== 'error') return
    expect(result.reason).toBe('network')
  })
})
