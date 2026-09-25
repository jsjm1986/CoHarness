/** Named external Providers cannot share routes or persisted child bindings. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ExternalBindingStore, externalMemberIdentity } from '../src/external.ts'

it('retains the default route and isolates arbitrary instance names on case-insensitive filesystems', async () => {
  expect(externalMemberIdentity('codex', 'codex', 'codex-member'))
    .toEqual({ route: 'codex-member', filename: 'codex.jsonl' })
  const names = ['secondary', 'SECONDARY', '../secondary', '二开', 'x'.repeat(512)]
  const identities = names.map(name => externalMemberIdentity(name, 'codex', 'codex-member'))
  expect(new Set(identities.map(identity => identity.filename.toLowerCase())).size).toBe(names.length)
  expect(new Set(identities.map(identity => identity.route)).size).toBe(names.length)
  const root = await mkdtemp(join(tmpdir(), 'member-identity-'))
  const child = SessionId('same-child')
  try {
    for (const [index, identity] of identities.entries()) {
      expect(identity.filename).toMatch(/^codex-[a-f0-9]{64}\.jsonl$/)
      new ExternalBindingStore(join(root, identity.filename)).bind(child, `external-${index}`)
    }
    for (const [index, name] of names.entries()) {
      const identity = externalMemberIdentity(name, 'codex', 'codex-member')
      expect(new ExternalBindingStore(join(root, identity.filename)).binding(child))
        .toEqual({ externalId: `external-${index}` })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
