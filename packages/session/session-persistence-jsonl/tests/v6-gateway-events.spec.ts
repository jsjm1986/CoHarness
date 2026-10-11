import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generationLogPath } from '../src/format.ts'

const id = SessionId('v6-gateway-events')
let root: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-v6-gateway-events-'))
})

afterEach(async () => {
  try {
    for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  return ctx
}

async function writeV6(rows: readonly object[]): Promise<string> {
  const path = generationLogPath(root, undefined, id, 6, 'none')
  await mkdir(dirname(path), { recursive: true })
  const header = { type: 'session', version: 6, id, createdAt: 1, isSeeded: false, delegationDepth: 0 }
  await writeFile(path, [header, ...rows.map((row, seq) => ({ ...row, seq, time: seq + 10 }))]
    .map(row => JSON.stringify(row)).join('\n') + '\n')
  return path
}

describe('V6-era gateway events in stored V6 logs', () => {
  it('migrates gateway/scoped-execution and gateway/continuation instead of refusing the log', async () => {
    const sourcePath = await writeV6([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'gateway/scoped-execution', data: { version: 1 } },
      { type: 'gateway/execution', data: { kind: 'accepted', state: {
        revision: '1', inputs: [], actors: [{ userId: 1 }], primaryActorUserId: 1, unverifiedHistory: false,
        scopeId: '10000000-0000-4000-8000-000000000001',
      } } },
      { type: 'gateway/continuation', data: {
        key: 'goal:g:1', scope: { parentSessionId: id, inputs: [], unverifiedHistory: true },
      } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const original = await readFile(sourcePath)
    const ctx = await mount()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    let events: readonly { type: string; seq: number }[]
    try {
      events = (await reader.read()).events
      expect(events.map(event => [event.type, event.seq])).toEqual([
        ['turn/start', 0], ['step/start', 1], ['gateway/scoped-execution', 2],
        ['gateway/execution', 3], ['gateway/continuation', 4], ['step/end', 5], ['turn/end', 6],
      ])
    } finally {
      await reader.close()
    }
    expect(await readFile(sourcePath)).toEqual(original)
    expect(await readdir(dirname(sourcePath))).toEqual(['session.v6.jsonl'])

    const writer = await ctx.sessionPersistence.open(id, 'write')
    try {
      expect((await writer.read()).events).toEqual(events)
    } finally {
      await writer.close()
    }
    expect(await readFile(sourcePath)).toEqual(original)
    const published = (await readFile(
      generationLogPath(root, undefined, id, SESSION_FORMAT_VERSION, 'none'), 'utf8',
    )).trimEnd().split('\n').map(line => JSON.parse(line) as { type: string })
    expect(published[0]).toMatchObject({ type: 'session', version: SESSION_FORMAT_VERSION, id })
    expect(published.slice(1).map(event => event.type)).toContain('gateway/scoped-execution')
  })

  it('still refuses a V6 log whose required event is foreign to this build', async () => {
    const sourcePath = await writeV6([
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'invented/event', data: { anything: true } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    const original = await stat(sourcePath)
    const ctx = await mount()
    await expect(ctx.sessionPersistence.open(id, 'read')).rejects.toThrow(SessionFormatUnsupportedError)
    expect(await stat(sourcePath)).toMatchObject({ size: original.size })
    expect(await readdir(dirname(sourcePath))).toEqual(['session.v6.jsonl'])
  })
})
