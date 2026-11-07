/** Account queries stay asynchronous and retain their native children through cancellation. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'

async function fixture(mode: 'document' | 'project', timeoutMs = 10_000) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-account-lookup-'))
  const entry = fileURLToPath(new URL('./fixtures/account-lookup-lifetime.mjs', import.meta.url))
  await writeFile(join(root, 'id'), `#!${process.execPath}\nprocess.env.ACCOUNT_LOOKUP_ARGS = JSON.stringify(process.argv.slice(2))\nprocess.argv = [process.argv[0], process.argv[1], 'id']\nawait import(${JSON.stringify(new URL('./fixtures/account-lookup-lifetime.mjs', import.meta.url).href)})\n`, { mode: 0o700 })
  const implementation = process.env.HGW_ACCOUNT_LOOKUP_IMPLEMENTATION === 'lib' ? 'lib' : 'src'
  const child = spawn(process.execPath, [...implementation === 'src' ? ['--import', 'tsx/esm'] : [], entry, mode, root, implementation, String(timeoutMs)], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', HGW_ACCOUNT_LOOKUP_FIXTURE: 'fixture', ACCOUNT_LOOKUP_TOKEN: 'fixture' },
  })
  const messages: { type: string; outcome?: string; survivingHelpers?: number[] }[] = []
  let output = ''
  child.stdout!.on('data', data => { output += String(data) })
  child.stderr!.on('data', data => { output += String(data) })
  child.on('message', message => { messages.push(message as typeof messages[number]) })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error(`Account fixture failed: ${code}/${signal}\n${output}`)))
  })
  void closed.catch(() => {})
  return {
    root, child, messages, closed,
    async ready(count: number) {
      await vi.waitFor(async () => {
        expect((await readdir(root)).filter(name => name.endsWith('.ready')).length).toBeGreaterThanOrEqual(count)
      }, { timeout: 10_000 })
    },
    async dispose() {
      await writeFile(join(root, 'release'), '')
      if (child.connected) child.send('finish')
      try { await closed } finally { await rm(root, { recursive: true, force: true }) }
    },
  }
}

it.skipIf(process.platform === 'win32')('answers other Gateway work while document account resolution waits on native identity lookup', async () => {
  const f = await fixture('document')
  try {
    await f.ready(1)
    f.child.send('ping')
    await vi.waitFor(() => expect(f.messages).toContainEqual({ type: 'pong' }), { timeout: 2_000 })
    expect(f.messages.some(message => message.type === 'settled')).toBe(false)
  } finally { await f.dispose() }
})

it.skipIf(process.platform === 'win32').each(['document', 'project'] as const)('joins both %s-account helpers before reporting cancellation', async mode => {
  const f = await fixture(mode)
  try {
    await f.ready(2)
    f.child.send('cancel')
    await vi.waitFor(() => expect(f.messages.some(message => message.type === 'settled')).toBe(true), { timeout: 5_000 })
    expect(f.messages.find(message => message.type === 'settled')).toMatchObject({ outcome: 'rejected', survivingHelpers: [] })
  } finally { await f.dispose() }
})

it.skipIf(process.platform === 'win32').each(['document', 'project'] as const)('closes TERM-resistant %s-account helpers at the configured deadline', async mode => {
  const f = await fixture(mode, 5_000)
  try {
    await f.ready(2)
    await vi.waitFor(() => expect(f.messages.some(message => message.type === 'settled')).toBe(true), { timeout: 10_000 })
    expect(f.messages.find(message => message.type === 'settled')).toMatchObject({ outcome: 'rejected', survivingHelpers: [] })
  } finally { await f.dispose() }
})

it.skipIf(process.platform === 'win32').each(['document', 'project'] as const)('filters Gateway and credential settings from literal %s-account queries', async mode => {
  const f = await fixture(mode)
  try {
    await f.ready(2)
    const observations = await Promise.all((await readdir(f.root)).filter(name => name.endsWith('.observed.json')).map(async name => JSON.parse(await readFile(join(f.root, name), 'utf8'))))
    expect(observations).toHaveLength(2)
    expect(observations).toEqual(expect.arrayContaining(['-u', '-g'].map(flag => ({
      gatewaySetting: false, credential: false, locale: 'C', args: [flag, '--', 'fixture-account'],
    }))))
    f.child.send('cancel')
    await vi.waitFor(() => expect(f.messages.some(message => message.type === 'settled')).toBe(true), { timeout: 5_000 })
  } finally { await f.dispose() }
})
