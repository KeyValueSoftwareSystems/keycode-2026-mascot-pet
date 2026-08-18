/**
 * Bounded, never-throwing HTTPS. The only place this app touches the network.
 *
 * Two verbs: `getCapped` for the broadcast manifest, `postCapped` for analytics. They share the URL
 * guard, the abort timeout, and the typed result, and differ on redirects — see `postCapped`.
 *
 * `fetch` is injected, so tests drive a real loopback server or a fake and never import Electron.
 * Production passes Electron's `net.fetch`, which routes through Chromium's network stack — that
 * brings system proxy configuration and enterprise policy for free, which matters for a tool being
 * installed on colleagues' managed laptops.
 *
 * ---------------------------------------------------------------------------------------
 * Redirects are followed manually, and that is a security requirement not a preference.
 * ---------------------------------------------------------------------------------------
 *
 * With `redirect: 'follow'`, the HTTPS-only check applies only to the URL we *asked* for. A server
 * answering `https://host/x` with `302 -> http://evil/y` would be followed silently, and the
 * "HTTPS only" rule would be void. openpets uses `node:https`, which does not follow redirects at
 * all and has no handling for them — so this case is simply absent there, and every plausible
 * manifest host (GitHub raw, S3 website endpoints, Gist) redirects.
 *
 * So: `redirect: 'manual'`, at most three hops, and `assertAllowedUrl` re-run on every one.
 *
 * ---------------------------------------------------------------------------------------
 * The promise never rejects.
 * ---------------------------------------------------------------------------------------
 *
 * Every failure is a typed result. A broadcast poll that throws is a broadcast poll that can crash
 * the pet, and the requirement is that a network problem is completely invisible to the user.
 */

import { assertAllowedUrl, UnsafeUrlError } from './url-guard.js'

export type HttpFailureReason =
  | 'timeout'
  | 'too-large'
  | 'status'
  | 'scheme'
  | 'redirect'
  | 'network'
  | 'decode'

export type HttpResult =
  | { kind: 'ok'; body: string; etag: string | null; finalUrl: string }
  | { kind: 'not-modified' }
  | { kind: 'error'; reason: HttpFailureReason; status?: number; detail?: string }

/**
 * The narrowest fetch signature this module needs.
 *
 * Deliberately not `typeof globalThis.fetch`: Electron's `net.fetch` accepts only
 * `string | Request`, not `URL`, so the wider type is not assignable. Since every call here passes a
 * string, saying so makes both the DOM fetch and Electron's satisfy it.
 */
export type CappedFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface FetchDeps {
  fetch: CappedFetch
}

export interface GetCappedOptions {
  etag: string | null
  timeoutMs: number
  maxBytes: number
  allowLoopbackHttp: boolean
  maxRedirects: number
  userAgent?: string
}

export async function getCapped(
  url: string,
  options: GetCappedOptions,
  deps: FetchDeps,
): Promise<HttpResult> {
  let target: URL
  try {
    target = assertAllowedUrl(url, { allowLoopbackHttp: options.allowLoopbackHttp })
  } catch (error) {
    return {
      kind: 'error',
      reason: 'scheme',
      detail: error instanceof UnsafeUrlError ? error.reason : String(error),
    }
  }

  let remainingHops = options.maxRedirects

  for (;;) {
    const attempt = await fetchOnce(target, options, deps)

    if (attempt.kind !== 'redirect') return attempt.result

    if (remainingHops <= 0) {
      return { kind: 'error', reason: 'redirect', detail: 'too many redirects' }
    }
    remainingHops -= 1

    try {
      // Resolved against the current URL so a relative Location works, then re-validated. This
      // re-check is the entire point of handling redirects by hand.
      target = assertAllowedUrl(new URL(attempt.location, target).toString(), {
        allowLoopbackHttp: options.allowLoopbackHttp,
      })
    } catch (error) {
      return {
        kind: 'error',
        reason: 'redirect',
        detail: `unsafe redirect target (${error instanceof UnsafeUrlError ? error.reason : 'invalid'})`,
      }
    }
  }
}

export interface PostCappedOptions {
  body: string
  timeoutMs: number
  maxBytes: number
  allowLoopbackHttp: boolean
  userAgent?: string
  contentType?: string
}

/**
 * A bounded, never-throwing HTTPS POST.
 *
 * **Redirects are refused outright rather than followed**, which is the one real difference from
 * `getCapped`. Following a redirected POST means deciding whether to re-send the body and whether to
 * rewrite the method — 301/302/303 turn a POST into a GET, 307/308 do not — and getting that wrong
 * either silently drops the payload or replays it against a host we have re-validated but did not
 * choose. There is no ingest endpoint worth that: the analytics host is a constant, and if it ever
 * starts redirecting, the right response is to change the constant, not to chase it at runtime.
 *
 * The response body is read and discarded. It is read rather than ignored so the connection can be
 * released, and capped for the same reason every other read here is.
 */
export async function postCapped(
  url: string,
  options: PostCappedOptions,
  deps: FetchDeps,
): Promise<HttpResult> {
  let target: URL
  try {
    target = assertAllowedUrl(url, { allowLoopbackHttp: options.allowLoopbackHttp })
  } catch (error) {
    return {
      kind: 'error',
      reason: 'scheme',
      detail: error instanceof UnsafeUrlError ? error.reason : String(error),
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs)
  ;(timer as unknown as { unref?: () => void }).unref?.()

  try {
    const response = await deps.fetch(target.toString(), {
      method: 'POST',
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      body: options.body,
      headers: {
        'content-type': options.contentType ?? 'application/json',
        accept: 'application/json',
        ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
      },
    })

    if (response.status >= 300 && response.status < 400) {
      return { kind: 'error', reason: 'redirect', detail: 'redirects are not followed on POST' }
    }

    if (!response.ok) {
      return { kind: 'error', reason: 'status', status: response.status }
    }

    const body = await readCapped(response, options.maxBytes)
    if (body.kind === 'error') return body

    return { kind: 'ok', body: body.text, etag: null, finalUrl: target.toString() }
  } catch (error) {
    const isAbort = (error as { name?: string })?.name === 'AbortError' || controller.signal.aborted
    return {
      kind: 'error',
      reason: isAbort ? 'timeout' : 'network',
      detail: String((error as Error)?.message ?? error).slice(0, 120),
    }
  } finally {
    clearTimeout(timer)
  }
}

type Attempt =
  | { kind: 'result'; result: HttpResult }
  | { kind: 'redirect'; location: string }

async function fetchOnce(
  target: URL,
  options: GetCappedOptions,
  deps: FetchDeps,
): Promise<Attempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeoutMs)
  // `unref` so a pending timeout cannot hold the process open at quit.
  ;(timer as unknown as { unref?: () => void }).unref?.()

  try {
    const response = await deps.fetch(target.toString(), {
      method: 'GET',
      redirect: 'manual',
      // No cookies, no credentials: a static manifest needs none, and sending them to a redirect
      // target would be worse.
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
        ...(options.etag ? { 'if-none-match': options.etag } : {}),
      },
    })

    // 304 MUST be checked before the redirect range: it is numerically inside 300-399, so a
    // range check first swallows it, finds no Location header, and reports a bogus redirect error.
    // Every conditional request would then look like a broken server.
    if (response.status === 304) {
      return { kind: 'result', result: { kind: 'not-modified' } }
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        return { kind: 'result', result: { kind: 'error', reason: 'redirect', detail: 'no location' } }
      }
      return { kind: 'redirect', location }
    }

    if (!response.ok) {
      return { kind: 'result', result: { kind: 'error', reason: 'status', status: response.status } }
    }

    // Refuse on the declared length before reading a single byte, when the server is honest enough
    // to declare one.
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      return {
        kind: 'result',
        result: { kind: 'error', reason: 'too-large', detail: `content-length ${declared}` },
      }
    }

    const body = await readCapped(response, options.maxBytes)
    if (body.kind === 'error') return { kind: 'result', result: body }

    return {
      kind: 'result',
      result: {
        kind: 'ok',
        body: body.text,
        etag: response.headers.get('etag'),
        finalUrl: target.toString(),
      },
    }
  } catch (error) {
    const isAbort =
      (error as { name?: string })?.name === 'AbortError' || controller.signal.aborted
    return {
      kind: 'result',
      result: {
        kind: 'error',
        reason: isAbort ? 'timeout' : 'network',
        detail: String((error as Error)?.message ?? error).slice(0, 120),
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the body, abandoning it the moment it exceeds the cap.
 *
 * A streaming cap, not a buffer-then-measure: the point is never to hold more than `maxBytes` in
 * memory, so a server that answers a 64KB request with a gigabyte cannot be used to exhaust it.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ kind: 'text'; text: string } | { kind: 'error'; reason: HttpFailureReason; detail?: string }> {
  const stream = response.body

  if (!stream) {
    // No stream (some fetch implementations, and empty responses). Fall back to text() but still
    // enforce the cap after the fact.
    const text = await response.text()
    if (byteLength(text) > maxBytes) {
      return { kind: 'error', reason: 'too-large', detail: 'body exceeded cap' }
    }
    return { kind: 'text', text }
  }

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('too large').catch(() => {})
        return { kind: 'error', reason: 'too-large', detail: `exceeded ${maxBytes} bytes` }
      }
      chunks.push(value)
    }
  } catch (error) {
    return { kind: 'error', reason: 'network', detail: String((error as Error)?.message ?? error) }
  } finally {
    reader.releaseLock?.()
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    // `fatal: true` so malformed UTF-8 is an error rather than a string full of replacement
    // characters that would then fail JSON parsing with a confusing message.
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(joined) }
  } catch {
    return { kind: 'error', reason: 'decode', detail: 'body is not valid UTF-8' }
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}
