/** Explicit, private inputs for a manual measurement against an existing QA deployment. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** No default target, credentials, or mutable user workspace is inferred. */
export interface ExistingLatencyConfig {
  version: 1
  origin: string
  platform: 'mac' | 'windows' | 'linux'
  release: string
  authenticationFile: string
  outputFile: string
  accountId: number
  nodeId: string
  runtimeId: string
  workspaceId: string
  workspacePath: string
  computerName: string
  language: 'en' | 'zh'
  testModelLabel: string
  historySessionId: string
  historyTitle: string
  historyMarker: string
  testPrefix: string
  samples: number
  timeoutMs: number
  settleTimeoutMs: number
  intervalMs: number
  browser: { engine: 'chromium' | 'webkit' | 'firefox'; executablePath?: string; cdpEndpoint?: string }
}

/** A bounded code, never the original diagnostic, is written to measurement receipts. */
export class MeasurementError extends Error {
  /** @param code - fixed or validated non-content diagnostic. */
  constructor(readonly code: string) { super(code); this.name = 'MeasurementError' }
}

/** Validate an object at the private configuration or HTTP boundary.
 * @param value - untrusted JSON.
 * @returns its object fields, without coercion.
 */
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MeasurementError('invalid-object')
  return value as Record<string, unknown>
}
function string(value: unknown, limit = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit || /[\r\n\0]/u.test(value)) throw new MeasurementError('invalid-string')
  return value
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new MeasurementError('invalid-number')
  return value
}
function uuid(value: unknown): string {
  const id = string(value, 36)
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(id)) throw new MeasurementError('invalid-identity')
  return id
}
function path(value: unknown): string {
  const result = string(value)
  if (!isAbsolute(result)) throw new MeasurementError('absolute-local-path-required')
  return result
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new MeasurementError('unknown-config-field')
}

/** Only explicit loopback QA origins are accepted; Windows may use an existing local tunnel.
 * @param value - origin without path, query, credentials or fragment.
 * @returns the canonical origin.
 */
function qaOrigin(value: unknown): string {
  const raw = string(value)
  let url: URL
  try { url = new URL(raw) } catch { throw new MeasurementError('invalid-origin') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) throw new MeasurementError('loopback-qa-origin-required')
  return url.origin
}

/** Parse the complete manual workload; omitted pacing controls receive plan-visible defaults.
 * @param input - private JSON configuration.
 * @returns resolved inputs without performing any network or browser operation.
 */
export function parseExistingLatencyConfig(input: unknown): ExistingLatencyConfig {
  const v = object(input)
  keys(v, ['version', 'origin', 'platform', 'release', 'authenticationFile', 'outputFile', 'accountId', 'nodeId',
    'runtimeId', 'workspaceId', 'workspacePath', 'computerName', 'language', 'testModelLabel', 'historySessionId', 'historyTitle', 'historyMarker',
    'testPrefix', 'samples', 'timeoutMs', 'settleTimeoutMs', 'intervalMs', 'browser'])
  if (v.version !== 1 || !['mac', 'windows', 'linux'].includes(String(v.platform))) throw new MeasurementError('invalid-version-or-platform')
  if (v.language !== 'en' && v.language !== 'zh') throw new MeasurementError('explicit-ui-language-required')
  const testPrefix = string(v.testPrefix, 64)
  if (!/^QA_PERF_[A-Za-z0-9_]{4,56}$/u.test(testPrefix)) throw new MeasurementError('dedicated-test-prefix-required')
  const historyTitle = string(v.historyTitle, 160), historyMarker = string(v.historyMarker, 200)
  if (!historyTitle.startsWith(testPrefix) || !historyMarker.startsWith(testPrefix)) throw new MeasurementError('dedicated-history-required')
  const historySessionId = string(v.historySessionId, 160)
  if (!/^[A-Za-z0-9_-]+$/u.test(historySessionId)) throw new MeasurementError('invalid-session-identity')
  const browser = object(v.browser)
  keys(browser, ['engine', 'executablePath', 'cdpEndpoint'])
  if (browser.engine !== 'chromium' && browser.engine !== 'webkit' && browser.engine !== 'firefox') throw new MeasurementError('invalid-browser-engine')
  if (browser.cdpEndpoint !== undefined && (browser.engine !== 'chromium' || browser.executablePath !== undefined)) throw new MeasurementError('invalid-cdp-options')
  if (browser.cdpEndpoint !== undefined && !qaOrigin(browser.cdpEndpoint).startsWith('http:')) throw new MeasurementError('http-loopback-cdp-required')
  const config: ExistingLatencyConfig = {
    version: 1, origin: qaOrigin(v.origin), platform: v.platform as ExistingLatencyConfig['platform'], release: string(v.release, 160),
    authenticationFile: path(v.authenticationFile), outputFile: path(v.outputFile),
    accountId: integer(v.accountId, 1, Number.MAX_SAFE_INTEGER),
    nodeId: uuid(v.nodeId), runtimeId: uuid(v.runtimeId), workspaceId: uuid(v.workspaceId), workspacePath: string(v.workspacePath),
    computerName: string(v.computerName, 160), language: v.language, testModelLabel: string(v.testModelLabel, 160),
    historySessionId, historyTitle, historyMarker, testPrefix,
    samples: integer(v.samples ?? 50, 1, 1000), timeoutMs: integer(v.timeoutMs ?? 30_000, 100, 300_000),
    settleTimeoutMs: integer(v.settleTimeoutMs ?? 120_000, 100, 600_000), intervalMs: integer(v.intervalMs ?? 1000, 0, 60_000),
    browser: { engine: browser.engine, ...(browser.executablePath === undefined ? {} : { executablePath: path(browser.executablePath) }),
      ...(browser.cdpEndpoint === undefined ? {} : { cdpEndpoint: qaOrigin(browser.cdpEndpoint) }) },
  }
  if (config.authenticationFile === config.outputFile) throw new MeasurementError('output-must-not-replace-authentication')
  return config
}

/** Read an owner-private regular file without following a link. Windows drivers need a separately audited ACL reader.
 * @param file - absolute local file path.
 * @returns bounded UTF-8 text; callers must never print authentication text.
 */
export async function privateText(file: string): Promise<string> {
  if (!isAbsolute(file)) throw new MeasurementError('absolute-local-path-required')
  if (process.platform === 'win32') throw new MeasurementError('private-file-posix-driver-required')
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new MeasurementError('private-file-required')
    return await handle.readFile('utf8')
  } finally { await handle.close() }
}

/** Parse one existing Gateway cookie, never a password or a copied multi-site browser profile.
 * @param text - private Cookie header containing exactly one name/value pair.
 * @returns cookie fields for the configured origin only.
 */
export function authenticationCookie(text: string): { name: string; value: string } {
  const match = /^([A-Za-z0-9_-]+)=([^\s;,=][^\s;,]*)$/u.exec(text.trim())
  const name = match?.[1], value = match?.[2]
  if (name === undefined || value === undefined || text.trim().length > 16384 || /[\x00-\x20\x7f]/u.test(text.trim())) {
    throw new MeasurementError('single-private-cookie-required')
  }
  return { name, value }
}

/** Content-free preview; it does not read the authentication file or contact the target.
 * @param config - parsed workload.
 * @returns intended effects and endpoints for review.
 */
export function measurementPlan(config: ExistingLatencyConfig) {
  return { execute: false, origin: config.origin, platform: config.platform, release: config.release,
    accountId: config.accountId, nodeId: config.nodeId, runtimeId: config.runtimeId, workspaceId: config.workspaceId,
    operations: ['hot-create', 'hot-open', 'durable-send'], samplesPerOperation: config.samples,
    timeoutMs: config.timeoutMs, settleTimeoutMs: config.settleTimeoutMs, intervalMs: config.intervalMs,
    maximumNewSessions: config.samples, maximumPrompts: config.samples, testPrefix: config.testPrefix,
    browser: config.browser.engine, language: config.language, dedicatedBrowser: true, cdp: config.browser.cdpEndpoint !== undefined,
    startsServers: false, explicitRuntimeStarts: false, changesPermissions: false, deletesData: false,
    requirements: ['ready-runtime', 'dedicated-idle-test-history-visible-in-sidebar', 'already-authorized-controlled-model', 'exclusive-measurement-window'],
    limitations: ['personal-runtime-only', 'POSIX-driver-private-files', 'CDP-must-be-a-dedicated-browser', 'no-automatic-retry-or-cancel'] }
}
