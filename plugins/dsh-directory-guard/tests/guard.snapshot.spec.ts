/**
 * Keyless snapshot of the guard's model-visible output: the deny reason is what
 * the model reads back as the tool result, so its wording is pinned here —
 * a reworded denial must be a conscious diff, not an accident. Scratch roots
 * are randomized by mkdtemp, so paths are normalized to {{root}} before
 * snapshotting.
 */
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { describe, expect, it } from 'vitest'
import type { Grant } from '../src/grants.ts'
import { decideDeny, type GuardExecution } from '../src/guard.ts'

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dg-snap-')))
}

async function deny(exec: GuardExecution, grants: readonly Grant[], cwd: string): Promise<string | null> {
  const fs = new LocalFileSystem(new Context(), { cwd, diffBasisMaxBytes: 1024 })
  return decideDeny(exec, grants, cwd, async (path, base) => fs.processPath(await fs.resolve(path, { cwd: base })))
}

function normalized(reason: string | null, root: string): string | null {
  return reason === null ? null : reason.split(root).join('{{root}}')
}

describe('deny wording (model-visible tool result)', () => {
  it('write outside every grant', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    const reason = await deny({ name: 'write', arguments: { file_path: join(root, 'escape.ts'), content: 'x' } }, grants, root)
    expect(normalized(reason, root)).toMatchInlineSnapshot(
      `"Write to {{root}}/escape.ts is not permitted: outside your read-write directories."`,
    )
  })

  it('write into a read-only grant', async () => {
    const root = scratch()
    const docs = join(root, 'docs'); mkdirSync(docs)
    const grants: Grant[] = [{ path: docs, mode: 'ro' }]
    const reason = await deny({ name: 'write', arguments: { file_path: join(docs, 'note.md'), content: 'x' } }, grants, root)
    expect(normalized(reason, root)).toMatchInlineSnapshot(
      `"Write to {{root}}/docs/note.md is not permitted: outside your read-write directories."`,
    )
  })

  it('read outside every grant', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    const reason = await deny({ name: 'read', arguments: { file_path: join(root, 'secret.txt') } }, grants, root)
    expect(normalized(reason, root)).toMatchInlineSnapshot(
      `"Access to {{root}}/secret.txt is not permitted: outside your allowed directories."`,
    )
  })

  it('malformed path argument on a path tool (fails closed)', async () => {
    const grants: Grant[] = [{ path: '/x', mode: 'rw' }]
    expect(await deny({ name: 'write', arguments: {} }, grants, '/x')).toMatchInlineSnapshot(
      `"write: missing or invalid path argument"`,
    )
  })

  it('in-grant write stays allowed (no denial text at all)', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(await deny({ name: 'write', arguments: { file_path: join(proj, 'ok.ts'), content: 'x' } }, grants, root)).toBeNull()
  })
})
