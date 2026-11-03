/** Relay input failures belong to the fixture disposer rather than uncaught network callbacks. */
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RUNTIME_PORT_PUBLISHER, runtimeRelay } from './runtime-relay.ts'

it.each(['', '0', '65536', 'invalid'])('reports invalid listener %j through awaited fixture cleanup', async value => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-relay-input-')), file = join(root, 'port')
  let dispose: (() => Promise<void>) | undefined
  try {
    await writeFile(file, value)
    const port = await runtimeRelay(file, cleanup => { dispose = cleanup })
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => { socket.destroy() })
    await once(socket, 'close')
    const cleanup = dispose!; dispose = undefined
    await expect(cleanup()).rejects.toThrow('fixture child published an invalid listener')
  } finally { try { await dispose?.() } finally { await rm(root, { recursive: true, force: true }) } }
})

it.each(['direct-write-control', 'atomic-publication'] as const)('observes the listener file before %s commits', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-relay-publication-')), file = join(root, 'port')
  await writeFile(file, '12345')
  const producer = mode === 'direct-write-control' ? '(function(file, port) { require("node:fs").writeFileSync(file, String(port)); })' : RUNTIME_PORT_PUBLISHER
  const child = spawn(process.execPath, ['-e', `
const fs = require('node:fs'), file = ${JSON.stringify(file)}, write = fs.writeFileSync, rename = fs.renameSync;
fs.writeFileSync = (path, value, ...options) => {
  if (path !== file) return write(path, value, ...options);
  write(path, ''); process.send('prepared');
  process.once('message', () => { write(path, value, ...options); process.disconnect(); });
};
fs.renameSync = (from, to) => {
  process.send('prepared'); process.once('message', () => { rename(from, to); process.disconnect(); });
};
${producer}(file, 23456);
`], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const closed = once(child, 'close'), prepared = once(child, 'message')
  let diagnostics = ''
  child.stderr!.on('data', chunk => { diagnostics += String(chunk) })
  try {
    await Promise.race([prepared, closed.then(() => { throw new Error(`Publisher exited before preparation: ${diagnostics}`) })])
    expect(await readFile(file, 'utf8')).toBe(mode === 'direct-write-control' ? '' : '12345')
    child.send('publish')
    const [code, signal] = await closed
    expect(signal).toBeNull(); expect(code).toBe(0)
    expect(await readFile(file, 'utf8')).toBe('23456')
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed }
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})
