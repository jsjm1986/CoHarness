/** Local executable that exercises tunnel pipes and signals without contacting Cloudflare. */
import { access, chmod, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Write a fixture executable under its caller-owned directory. */
export async function writeTunnelBinary(root) {
  const entry = new URL('./tunnel-binary.mjs', import.meta.url).href
  const binary = join(root, 'cloudflared-fixture')
  await writeFile(binary, `#!${process.execPath}\nimport { runTunnelBinary } from ${JSON.stringify(entry)};\nawait runTunnelBinary(${JSON.stringify(root)});\n`)
  await chmod(binary, 0o700)
  return binary
}

/** Drain-sensitive local connector with a durable closure witness and synthetic environment observations. */
export async function runTunnelBinary(root) {
  const mode = process.argv.includes('--url') ? 'quick' : 'named'
  const marker = join(root, `tunnel-${mode}`)
  const probeToken = randomUUID()
  const control = createServer((req, res) => { res.end(req.url === `/${probeToken}` ? probeToken : 'unknown fixture') })
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve))
  process.once('SIGTERM', () => {
    void writeFile(`${marker}.stopped`, 'closed\n').then(() => process.exit(0), () => process.exit(1))
  })
  if (mode === 'quick') {
    await new Promise(resolve => process.stdout.write('https://fixture.trycloud', resolve))
    await new Promise(resolve => process.stdout.write('flare.com\n', resolve))
  }
  for (const stream of [process.stdout, process.stderr]) await new Promise(resolve => stream.write(Buffer.alloc(2 ** 20, 120), resolve))
  const presence = Object.fromEntries(['HGW_DATABASE_URL', 'HGW_TEST_DATABASE_URL', 'HGW_USERS_ROOT', 'DATABASE_URL', 'CLOUD_CREDENTIALS']
    .map(name => [name, Object.hasOwn(process.env, name)]))
  const pending = `${marker}.prepared.${process.pid}`
  await writeFile(pending, JSON.stringify({ deploymentEnvironment: presence, pathAvailable: Boolean(process.env.PATH),
    argumentTokenExposed: process.argv.includes('synthetic-run-token'), selectedTokenAvailable: process.env.TUNNEL_TOKEN === 'synthetic-run-token',
    probeToken, controlUrl: `http://127.0.0.1:${control.address().port}/${probeToken}`,
  }) + '\n')
  await rename(pending, `${marker}.prepared`)
  for (;;) {
    try { await access(`${marker}.register`); break } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(25)
  }
  const position = process.argv.indexOf('--pidfile')
  if (position < 0) throw new Error('Fixture requires a private registration file')
  await writeFile(process.argv[position + 1], String(process.pid))
}
