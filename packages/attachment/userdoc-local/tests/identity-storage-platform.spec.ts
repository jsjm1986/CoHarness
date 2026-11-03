/** Hosts omitting POSIX open flags retain private-layout and metadata-domain checks. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import { DocumentIdentityStorage } from '../src/identity-storage.ts'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined, O_NONBLOCK: undefined } }
})

it('reads its regular private marker when the platform omits POSIX-specific flags', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-storage-no-posix-flags-'))
  onTestFinished(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'documents')
  await mkdir(root)
  const storage = await DocumentIdentityStorage.open({ root, stateRoot: join(base, 'state'), filesRoot: join(base, 'files') })
  await writeFile(storage.databasePath, 'metadata', { mode: 0o600 })
  const rootId = UserDocRootId(randomUUID())
  await storage.bindDomain(rootId)
  await expect(storage.bindDomain(rootId)).resolves.toBeUndefined()
})
