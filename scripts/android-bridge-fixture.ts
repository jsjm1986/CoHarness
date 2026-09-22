/** Private HTTP observation point for the installed Android activity and native JavaScript bridge. */
import { createServer } from 'node:http'
import { once } from 'node:events'

/** Reject empty, skipped or failing instrumentation, including a missing real-activity scenario.
 * @param output - raw `am instrument -w -r` output.
 */
export function assertAndroidBridgeEvidence(output: string): void {
  let fields: Record<string, string> = {}
  let activityPassed = false
  let unverified = false
  for (const line of output.split(/\r?\n/)) {
    const field = /^INSTRUMENTATION_STATUS: (\w+)=(.*)$/.exec(line)
    if (field?.[1] !== undefined) fields[field[1]] = field[2] ?? ''
    const code = /^INSTRUMENTATION_STATUS_CODE: (-?\d+)/.exec(line)
    if (code === null) continue
    if (Number(code[1]) < 0) unverified = true
    if (Number(code[1]) === 0 && fields.class === 'com.coharness.NativePushBridgeTest'
      && fields.test === 'realActivityDeliversLaunchIntentThroughTheWebViewBridge') activityPassed = true
    fields = {}
  }
  if (!activityPassed || unverified || !/OK \([1-9]\d* tests?\)/.test(output)
    || /FAILURES|INSTRUMENTATION_FAILED|Process crashed/.test(output)) {
    throw new Error('check-android: instrumentation did not prove the real activity bridge and all required tests')
  }
}

/** Start a per-run endpoint; adb reverse exposes it only to the selected emulator.
 * @returns the bound port and an awaited connection cleanup operation.
 */
export async function startAndroidBridgeFixture(): Promise<{ port: number; close(): Promise<void> }> {
  const observations = new Map<string, { count: number; payload: unknown }>()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'POST' && url.pathname === '/observed') {
      request.setEncoding('utf8')
      let body = ''
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        let payload: unknown
        try { payload = JSON.parse(body) as unknown } catch { response.writeHead(400).end(); return }
        if (payload === null || typeof payload !== 'object' || !('sessionId' in payload) || typeof payload.sessionId !== 'string') {
          response.writeHead(400).end()
          return
        }
        observations.set(payload.sessionId, { count: (observations.get(payload.sessionId)?.count ?? 0) + 1, payload })
        response.writeHead(204).end()
      })
      return
    }
    if (url.pathname === '/observed') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ observed: observations.get(url.searchParams.get('session') ?? '') ?? null }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end('<!doctype html><html><head><title>Native bridge probe</title></head><body><script>'
      + 'window.Capacitor.addListener("NativePushStatus", "notificationAction", payload => '
      + 'fetch("/observed", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)}));'
      + '</script></body></html>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Android fixture has no TCP address')
  return { port: address.port, close: async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
  } }
}
