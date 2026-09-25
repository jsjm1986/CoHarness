/** Fixture admission preserves distinct request identities and rejects run-local IDs. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertFixtureInventory } from '../apps/web/tests/scaffold.ts'

async function checkFixture(rpcIds: string[]): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'web-fixture-inventory-'))
  try {
    const rows = rpcIds.map(rpcId => JSON.stringify({ type: 'user/message', data: { source: { kind: 'user', rpcId } } }))
    await writeFile(join(dir, 'session.jsonl'), `${rows.join('\n')}\n`)
    await assertFixtureInventory(dir, ['session.jsonl'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

it('accepts repeated and distinct canonical request tokens', async () => {
  await expect(checkFixture(['{{rpcId}}', '{{rpc:1}}', '{{rpc:2}}', '{{rpc:1}}', '{{rpc:10}}'])).resolves.toBeUndefined()
})

it.each(['request-1735', '{{rpc:0}}', '{{rpc:01}}', '{{rpc:-1}}', '{{rpc:1}}suffix', '{{rpcId}}suffix', ''])
('rejects a noncanonical request ID: %s', async (rpcId) => {
  await expect(checkFixture([rpcId])).rejects.toThrow('carries a run-local rpcId')
})
