/** Historical reviews use persisted Session references and survive independent Host lifetimes. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionPersistenceReadError } from '@deepseek-ai/dsh-session-persistence'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { afterEach, expect, it, vi } from 'vitest'
import * as Changes from '../src/index.ts'
import { endTurn, git, settle, startTurn, toolCall } from './support.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function boot(root: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(Changes, { storageRoot: join(root, 'reviews') } as Changes.Config)
  return ctx
}

it('serves the same recorded bytes after Host restart without loading an Agent or reading the current file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durable-workspace-review-'))
  roots.push(root)
  const cwd = join(root, 'workspace')
  git(root, 'init', '-q', cwd)
  await writeFile(join(cwd, 'file.txt'), 'original content\n')
  const first = await boot(root), id = SessionId('persisted-review')
  const accepted: SessionEvent[] = []
  first.on('session/event', (session, event) => { if (session.id === id) accepted.push(event) })
  const session = first.sessions.create(id, { meta: { cwd } })
  startTurn(session, 1)
  await settle(first, session)
  await writeFile(join(cwd, 'file.txt'), 'saved historical content\n')
  toolCall(session, 1, 'bash', { command: 'edit fixture' })
  endTurn(session, 1)
  await settle(first, session)
  const writer = await first.sessionPersistence.create(session.header)
  try { await writer.append(accepted) } finally { await writer.close() }
  const events = await first.sessionPersistence.readPage(id, { maxEvents: 100 })
  const event = events.events.find(event => event.type === 'workspace/changes')!
  const summary = await first.workspaceChanges.summary(id, event.seq)
  await expect(first.workspaceChanges.removeStored(id)).rejects.toThrow('Release the Session')
  const diff = await first.workspaceChanges.diff(id, event.seq, 0, new AbortController().signal)
  expect(diff).toMatchObject({ kind: 'text', hunks: [{ lines: ['-original content', '+saved historical content'] }] })
  await first.fiber.dispose()
  await rm(join(cwd, 'file.txt'))
  const restored = await boot(root)
  expect(restored.sessions.get(id)).toBeUndefined()
  expect(await restored.workspaceChanges.summary(id, event.seq)).toEqual(summary)
  expect(await restored.workspaceChanges.diff(id, event.seq, 0, new AbortController().signal)).toEqual(diff)
  expect(restored.sessions.get(id)).toBeUndefined()
  expect(await restored.workspaceChanges.summary(id, event.seq + 1)).toBeUndefined()
  const read = vi.spyOn(restored.sessionPersistence, 'readPage')
  read.mockRejectedValueOnce(new SessionPersistenceReadError('dependency', 'concurrent resume'))
  expect(await restored.workspaceChanges.summary(id, event.seq)).toEqual(summary)
  expect(read).toHaveBeenCalledTimes(2)
  read.mockClear()
  read.mockRejectedValueOnce(new SessionPersistenceReadError('dependency', 'changing'))
    .mockRejectedValueOnce(new SessionPersistenceReadError('dependency', 'still changing'))
  await expect(restored.workspaceChanges.summary(id, event.seq)).rejects.toThrow('still changing')
  expect(read).toHaveBeenCalledTimes(2)
  read.mockClear()
  read.mockRejectedValueOnce(new SessionPersistenceReadError('protocol', 'corrupt page'))
  await expect(restored.workspaceChanges.summary(id, event.seq)).rejects.toThrow('corrupt page')
  expect(read).toHaveBeenCalledOnce()
  read.mockClear()
  const controller = new AbortController()
  read.mockImplementationOnce(async () => {
    controller.abort()
    throw new SessionPersistenceReadError('dependency', 'cancelled resume')
  })
  await expect(restored.workspaceChanges.summary(id, event.seq, controller.signal)).rejects.toThrow('cancelled resume')
  expect(read).toHaveBeenCalledOnce()
  read.mockRestore()
  await restored.workspaceChanges.removeStored(id)
  expect(await restored.workspaceChanges.summary(id, event.seq)).toBeUndefined()
})

it.each(['incomplete', 'legacy', 'missing-workspace'] as const)('preserves the meaning of a cold %s announcement', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'review-announcement-'))
  roots.push(root)
  const first = await boot(root), id = SessionId('old-announcement')
  const session = first.sessions.create(id, { meta: kind === 'missing-workspace' ? {} : { cwd: root } })
  const event = session.append('workspace/changes', kind === 'legacy' ? { turn: 1 } : { turn: 1, incomplete: true })
  const writer = await first.sessionPersistence.create(session.header)
  try { await writer.append([event]) } finally { await writer.close() }
  await first.fiber.dispose()
  const reopened = await boot(root)
  const summary = await reopened.workspaceChanges.summary(id, event.seq)
  if (kind === 'incomplete') expect(summary).toMatchObject({ turn: 1, incomplete: true, cwd: root })
  else expect(summary).toBeUndefined()
  expect(await reopened.workspaceChanges.diff(id, event.seq, 0, new AbortController().signal)).toBeUndefined()
})
