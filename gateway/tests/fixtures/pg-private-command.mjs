/** Real child pipes witness credential placement, readiness, SQL admission and cancellation. */
import assert from 'node:assert/strict'
import { appendFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'

const [selectedKind, root, mode = 'normal'] = process.argv.slice(2)
const args = process.argv.slice(5)
const kind = selectedKind === 'paired' ? args.some(value => /^psql\.exe$/iu.test(value)) ? 'psql' : 'archive' : selectedKind
const event = value => appendFile(join(root, 'events.jsonl'), JSON.stringify({ kind, pid: process.pid, ...value }) + '\n')
const marker = args.find(value => value.startsWith('--hgw-connection-stdin-v1='))
await event({ phase: 'started', args })
if (mode === 'closed-input') {
  const closed = once(process.stdin, 'close')
  process.stdin.destroy()
  await closed
  process.exit(0)
}
if (kind === 'archive') {
  for await (const _chunk of process.stdin) { /* The archive reader consumes its private fixture input. */ }
  if (!args.includes('--list')) process.stdout.write('SELECT 1;\n')
} else {
  const nonce = kind === 'adapter' ? args[args.indexOf('--resolve-stdin-v1') + 1]
    : marker?.slice('--hgw-connection-stdin-v1='.length)
  assert.match(nonce ?? '', /^[a-f0-9]{32}$/u)
  let pending = Buffer.alloc(0), connection, tail = Buffer.alloc(0)
  for await (const chunk of process.stdin) {
    if (connection !== undefined) { tail = Buffer.concat([tail, chunk]); continue }
    pending = Buffer.concat([pending, chunk])
    if (pending.length < 4 || pending.length < 4 + pending.readUInt32BE()) continue
    const length = pending.readUInt32BE()
    connection = pending.subarray(4, 4 + length).toString()
    tail = pending.subarray(4 + length)
    await event({ phase: 'connection', connection, initialTailBytes: tail.length })
    if (mode === 'invalid-connection') {
      process.stderr.write('hgw-pg-client: invalid connection input\n')
      process.exit(1)
    }
    if (mode === 'hang') { await new Promise(() => { setInterval(() => {}, 1000) }); }
    if (mode === 'bad-ack') { process.stdout.write('unsupported wrapper\n'); continue }
    if (mode === 'no-ack') continue
    if (kind !== 'adapter') {
      for (const part of [`hgw-pg-client/1 ${nonce.slice(0, 7)}`, `${nonce.slice(7)}\n`]) {
        await new Promise((resolve, reject) => process.stdout.write(part, error => error ? reject(error) : resolve()))
      }
      await event({ phase: 'acknowledged' })
    }
  }
  assert.notEqual(connection, undefined)
  if (kind === 'adapter') {
    if (mode === 'bad-metadata') process.stdout.write('invalid metadata\n')
    else if (mode === 'overflow') process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 65))
    else process.stdout.write(`hgw-pg-client/1 ${nonce} 180006\nuser\0fixture\0dbname\0db\0password\0synthetic'行\\\n\0service\0selected-service\0`)
  } else {
    await event({ phase: 'input-ended', tail: tail.toString() })
    if (mode === 'post-ack-hold') {
      while (true) {
        try { await access(join(root, 'release')); break } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    if (mode === 'nonzero') process.exitCode = 9
    else if (mode !== 'bad-ack' && mode !== 'no-ack' && kind === 'dump') process.stdout.write('fixture custom archive\n')
  }
}
