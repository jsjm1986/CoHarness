/** Native fixture cleanup remains active after assertion failure and without a started client. */
import { afterAll, describe, expect } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createClientTest, webApp, type TestClient } from '../src/assembly/index.ts'

type RemoteFace = Record<string, Record<string, (...args: unknown[]) => unknown>>

/** One settled command execution as `commands/execute` acknowledges it. */
const EXECUTION = { commandId: 'cmd-1' as CommandId, result: { kind: 'success' as const, text: 'done' } }

const test = createClientTest({ roster: webApp.closure(['@deepseek-ai/dsh-client-runtime']) })
const clients: TestClient[] = []
const expired: (() => Promise<TestClient>)[] = []

afterAll(async () => {
  expect(clients).toHaveLength(2)
  for (const client of clients) {
    expect(client.ctx.get('loader')).toBeUndefined()
    expect(client.mock.log.streams('events.mux').map(stream => stream.state)).toEqual(['cancelled'])
  }
  for (const start of expired) {
    await expect(start()).rejects.toThrow('after its test fixture closed')
  }
  expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
})

describe('createClientTest', () => {
  test('allows response configuration before boot and shares concurrent starts', async ({ mock, remote, start }) => {
    expired.push(start)
    expect(remote).toBe(mock.remote)
    remote.commands.execute.mockResolvedValueOnce(ok(EXECUTION))
    const first = start()
    const second = start()
    expect(second).toBe(first)
    const client = await first
    clients.push(client)
    expect(client.mock).toBe(mock)
    expect(mock.log.streams('events.mux')).toHaveLength(1)
    await expect((client.ctx.remote as unknown as RemoteFace).commands!.execute!({ sessionId: 's' as SessionId, name: 'status' }))
      .resolves.toEqual(ok(EXECUTION))
    expect(remote.commands.execute).toHaveBeenCalledExactlyOnceWith({ sessionId: 's', name: 'status' })
  })

  test.fails('disposes its client even when the test assertion fails', async ({ start }) => {
    expired.push(start)
    clients.push(await start())
    expect.fail('fixture cleanup negative control')
  })

  test('does not boot an unused start fixture', ({ mock, start }) => {
    expired.push(start)
    expect(mock.log.streams()).toEqual([])
    expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
  })

  test('owns a fresh mock when only the mock fixture is requested', ({ mock }) => {
    expect(mock.log.calls()).toEqual([])
    expect(mock.log.streams()).toEqual([])
    expect(mock.endpoints()).not.toContain('commands/execute')
  })
})

const missingConnection = createClientTest({ roster: webApp.pick(['@deepseek-ai/dsh-typert-registry']) })
missingConnection('reports a missing connection through the service getter, not startup', async ({ start }) => {
  expired.push(start)
  const client = await start()
  expect(() => client.connection).toThrow('provides no `connection` service')
  expect('__DSH_TRANSPORT__' in globalThis).toBe(false)
})
