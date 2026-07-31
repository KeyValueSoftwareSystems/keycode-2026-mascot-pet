/**
 * URL validation. The single gate every remote URL passes through.
 *
 * Two things depend on this being right: the manifest fetch, and `shell.openExternal`. The second is
 * the sharper one — `openExternal` on an unvalidated string is a genuine local-execution vector
 * (`file://`, `smb://`, a registered custom scheme), and the manifest is remote input.
 *
 * HTTPS is the only scheme allowed in production. The one exception is loopback HTTP for the local
 * dev manifest server, and it is gated on **two independent conditions**: the caller must pass
 * `allowLoopbackHttp`, and the only caller computes that from `!app.isPackaged && <env flag>`.
 * `app.isPackaged` is not env-overridable, so a packaged build cannot be talked into loopback HTTP
 * even by someone who sets the flag.
 */

export class UnsafeUrlError extends Error {
  readonly reason: string

  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason)
    this.name = 'UnsafeUrlError'
    this.reason = reason
  }
}

/** Hostnames that count as loopback for the dev-server exception. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export interface UrlGuardOptions {
  /** Permit http:// to a loopback host. Dev only; see the module comment. */
  allowLoopbackHttp?: boolean
}

/**
 * Parse and validate a URL, or throw.
 *
 * Throws rather than returning null so a caller cannot accidentally ignore the result — every use of
 * a remote URL in this app is security-relevant enough to deserve an exception.
 */
export function assertAllowedUrl(raw: unknown, options: UrlGuardOptions = {}): URL {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new UnsafeUrlError('not-a-string', typeof raw)
  }

  // A protocol-relative URL ("//host/path") inherits the scheme of the page it came from. There is no
  // page here, so it is meaningless — and `new URL` would reject it anyway. Named explicitly because
  // it is an easy thing to put in a JSON file by mistake.
  if (raw.startsWith('//')) {
    throw new UnsafeUrlError('protocol-relative', raw.slice(0, 60))
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeUrlError('unparseable', raw.slice(0, 60))
  }

  if (url.protocol === 'https:') return url

  if (url.protocol === 'http:') {
    if (options.allowLoopbackHttp && LOOPBACK_HOSTS.has(url.hostname)) return url
    throw new UnsafeUrlError('insecure-scheme', `${url.protocol}//${url.hostname}`)
  }

  // Everything else: file:, data:, javascript:, ws:, ftp:, smb:, and any custom scheme some other
  // installed application has registered.
  throw new UnsafeUrlError('forbidden-scheme', url.protocol)
}

/** Non-throwing form, for the many places where a bad URL simply means "no link". */
export function safeUrl(raw: unknown, options: UrlGuardOptions = {}): URL | null {
  try {
    return assertAllowedUrl(raw, options)
  } catch {
    return null
  }
}
