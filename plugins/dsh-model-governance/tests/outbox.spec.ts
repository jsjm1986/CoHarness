import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UsageOutbox, type GovernanceRecord, type UsageRecord } from '../src/outbox.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'outbox fixture cleanup failed')
})

function usage(eventId: string): UsageRecord {
  return { eventId, occurredAt: 1, provider: 'p', model: 'm', purpose: 'assistant',
    credentialSource: 'organization', credentialClass: 'company', status: 'succeeded' }
}

async function fixture(rejected: GovernanceRecord, status: number) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-outbox-delivery-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const accepted = usage('b-accepted')
  await writeFile(join(root, `${rejected.eventId}.json`), JSON.stringify(rejected))
  await writeFile(join(root, `${accepted.eventId}.json`), JSON.stringify(accepted))
  const received: GovernanceRecord[] = []
  let resolveFirst!: () => void
  let rejectFirst!: (error: unknown) => void
  const first = new Promise<void>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as GovernanceRecord
      received.push(body)
      res.writeHead(body.eventId === rejected.eventId ? status : 200).end('{}')
      resolveFirst()
    })().catch(error => { rejectFirst(error); res.destroy() })
  })
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const outbox = new UsageOutbox(root, `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/usage`, 'fixture-token')
  cleanups.push(() => outbox.close())
  return { root, received, first, outbox, accepted }
}

describe('independent outbox delivery', () => {
  it.each<GovernanceRecord>([
    { ...usage('a-rejected'), actorUserId: 7, executionInputIds: ['verified-input'] },
    usage('a-rejected'),
    { kind: 'model-registration', eventId: 'a-rejected', occurredAt: 1, provider: 'p', action: 'provider-created', scope: 'personal' },
  ])('retains a rejected record while delivering later valid records (%#)', async rejected => {
    const f = await fixture(rejected, 400)
    await vi.waitFor(async () => { expect(await readdir(f.root)).toEqual(['a-rejected.json']) }, { timeout: 2_000 })
    await f.outbox.close()
    expect(f.received).toEqual([rejected, f.accepted])
    expect(JSON.parse(await readFile(join(f.root, 'a-rejected.json'), 'utf8'))).toEqual(rejected)
  })

  it('retains the remaining batch when the intake is unavailable', async () => {
    const rejected = usage('a-rejected')
    const f = await fixture(rejected, 503)
    await f.first
    await f.outbox.close()
    expect(f.received).toEqual([rejected])
    expect((await readdir(f.root)).sort()).toEqual(['a-rejected.json', 'b-accepted.json'])
  })
})
