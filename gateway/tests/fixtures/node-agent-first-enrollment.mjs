/** Native first-enrollment process fixture; owns its state tree, listener and child. */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Run the actual Node Agent against a loopback refusal from a fresh nested state directory.
 * @param {string | undefined} builtEntry - plain-Node deployment entry; absent runs the source launcher.
 * @returns {Promise<object>} keyless process, request and durable-state observations.
 */
export async function firstEnrollment(builtEntry) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-first-enrollment-'))
  const stateFile = join(root, 'new', 'nested', 'access.json')
  const token = `dsh_enroll_${randomBytes(32).toString('base64url')}`
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url })
    req.resume()
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'node-access/unauthorized' }))
  })
  let child, closed, timer, timedOut = false, stdout = '', stderr = ''
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Loopback fixture address unavailable')
    const centerUrl = `http://127.0.0.1:${address.port}`
    const args = builtEntry === undefined
      ? ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('../../src/node-agent-main.ts', import.meta.url))]
      : [builtEntry]
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(HGW_|DSH_|NODE_OPTIONS$|DATABASE_URL$|PGPASSWORD$)/iu.test(key)))
    child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env,
      HGW_NODE_CENTER_URL: centerUrl, HGW_NODE_AGENT_STATE_FILE: stateFile,
      HGW_NODE_CONNECTION_FILE: join(root, 'unconfigured.json'), HGW_NODE_ENROLLMENT_TOKEN: token,
      HGW_NODE_AGENT_CHANNEL_ENABLED: '0', TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.run.json', import.meta.url)),
    } })
    closed = new Promise((done, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => done({ code, signal }))
    })
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 65_536) child.kill('SIGKILL') })
    child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 65_536) child.kill('SIGKILL') })
    // The child boundary also contains a microtask loop that cannot observe AbortSignal.
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 25_000)
    const result = await closed
    clearTimeout(timer)
    if (timedOut) throw new Error('First enrollment exceeded its process deadline')
    if (result.signal !== null) throw new Error(`First enrollment ended by ${result.signal}`)
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    const events = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const failures = stderr.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    return { exitCode: result.code, timedOut, signal: result.signal, requests,
      stopped: events.some(event => event.status === 'stopped'),
      failure: failures.at(-1)?.reason, pendingCredential: /^dsh_node_/u.test(state.credential),
      pendingTicketPreserved: state.enrollmentToken === token, identityAssigned: state.identity !== null,
      secretLogged: stdout.includes(token) || stderr.includes(token) || stdout.includes(state.credential) || stderr.includes(state.credential) }
  } finally {
    clearTimeout(timer)
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (closed !== undefined) await closed
    server.closeAllConnections()
    await new Promise((done, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done()))
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await firstEnrollment(process.argv[2]), null, 2) + '\n')
}
