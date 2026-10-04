import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { Grant } from '../src/grants.ts'
import { decideDeny } from '../src/guard.ts'
import { registerGuard } from '../src/dsh-adapter.ts'

const scratchRoots: string[] = []

/** A private scratch root, removed at test end; only this run's roots are tracked. */
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dg-')))
  scratchRoots.push(root)
  return root
}

afterEach(() => {
  while (scratchRoots.length > 0) rmSync(scratchRoots.pop()!, { recursive: true, force: true })
})

describe('decideDeny', () => {
  it('allows writes inside an rw grant and denies outside', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(decideDeny({ name: 'write', arguments: { file_path: join(proj, 'a.ts'), content: 'x' } }, grants, root)).toBeNull()
    expect(decideDeny({ name: 'edit', arguments: { file_path: join(proj, 'a.ts') } }, grants, root)).toBeNull()
    const denied = decideDeny({ name: 'write', arguments: { file_path: join(root, 'outside.ts'), content: 'x' } }, grants, root)
    expect(denied).toContain('outside.ts')
  })

  it('denies writes to a read-only grant but allows reads there', () => {
    const root = scratch()
    const docs = join(root, 'docs'); mkdirSync(docs)
    const grants: Grant[] = [{ path: docs, mode: 'ro' }]
    expect(decideDeny({ name: 'read', arguments: { file_path: join(docs, 'r.md') } }, grants, root)).toBeNull()
    expect(decideDeny({ name: 'write', arguments: { file_path: join(docs, 'r.md'), content: 'x' } }, grants, root)).not.toBeNull()
  })

  it('handles str_replace_editor commands (view read vs create/str_replace/insert write)', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    expect(decideDeny({ name: 'str_replace_editor', arguments: { command: 'view', path: join(proj, 'a.ts') } }, grants, root)).toBeNull()
    expect(decideDeny({ name: 'str_replace_editor', arguments: { command: 'create', path: join(proj, 'a.ts'), file_text: 'x' } }, grants, root)).not.toBeNull()
    expect(decideDeny({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: join(proj, 'a.ts') } }, grants, root)).not.toBeNull()
  })

  it('denies reads entirely outside any grant', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(decideDeny({ name: 'read', arguments: { file_path: '/etc/hosts' } }, grants, root)).not.toBeNull()
  })

  it('resolves relative paths against cwd and blocks .. escapes', () => {
    const root = scratch()
    const home = join(root, 'home'); mkdirSync(home)
    const grants: Grant[] = [{ path: home, mode: 'rw' }]
    expect(decideDeny({ name: 'write', arguments: { file_path: 'note.txt', content: 'x' } }, grants, home)).toBeNull()
    expect(decideDeny({ name: 'write', arguments: { file_path: '../escape.txt', content: 'x' } }, grants, home)).not.toBeNull()
  })

  it('delegates (null) for tools without a known path argument', () => {
    const grants: Grant[] = [{ path: '/x', mode: 'rw' }]
    expect(decideDeny({ name: 'bash', arguments: { command: 'ls /etc' } }, grants, '/x')).toBeNull()
    expect(decideDeny({ name: 'web_search', arguments: { query: 'hi' } }, grants, '/x')).toBeNull()
  })

  it('denies when a path argument is missing or not a string', () => {
    const grants: Grant[] = [{ path: '/x', mode: 'rw' }]
    expect(decideDeny({ name: 'write', arguments: {} }, grants, '/x')).not.toBeNull()
    expect(decideDeny({ name: 'read', arguments: { file_path: 123 } }, grants, '/x')).not.toBeNull()
  })

  it('treats grep and glob as reads of their traversal root', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const outside = join(root, 'outside'); mkdirSync(outside)
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    for (const name of ['grep', 'glob']) {
      expect(decideDeny({ name, arguments: { path: proj, pattern: 'x', include: '*.ts' } }, grants, root)).toBeNull()
      const denied = decideDeny({ name, arguments: { path: outside, pattern: 'x' } }, grants, root)
      expect(denied).toContain('outside your allowed directories')
      expect(decideDeny({ name, arguments: { path: '../outside' } }, grants, proj)).not.toBeNull()
    }
  })

  it('defaults a search tool path to the session cwd only when absent', () => {
    const root = scratch()
    const home = join(root, 'home'); mkdirSync(home)
    const outside = join(root, 'outside'); mkdirSync(outside)
    const grants: Grant[] = [{ path: home, mode: 'rw' }]
    for (const name of ['grep', 'glob']) {
      expect(decideDeny({ name, arguments: { pattern: 'x' } }, grants, home)).toBeNull()
      expect(decideDeny({ name, arguments: { pattern: 'x' } }, grants, outside)).not.toBeNull()
      expect(decideDeny({ name, arguments: { path: '' } }, grants, home)).not.toBeNull()
      expect(decideDeny({ name, arguments: { path: null } }, grants, home)).not.toBeNull()
      expect(decideDeny({ name, arguments: { path: 42 } }, grants, home)).not.toBeNull()
    }
  })

  it('blocks a search whose path escapes through a symlinked root', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const outside = join(root, 'outside'); mkdirSync(outside)
    // 'junction' is the unprivileged Windows link type; the target is absolute.
    symlinkSync(outside, join(proj, 'link'), 'junction')
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    for (const name of ['grep', 'glob']) {
      expect(decideDeny({ name, arguments: { path: join(proj, 'link') } }, grants, root)).not.toBeNull()
      expect(decideDeny({ name, arguments: { path: join(proj, '..', 'outside') } }, grants, root)).not.toBeNull()
    }
  })

  it('delegates tools whose names only collide with the file-path table prototype', () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    for (const name of ['constructor', 'hasOwnProperty', 'toString']) {
      expect(decideDeny({ name, arguments: { file_path: join(root, 'escape.ts') } }, grants, root)).toBeNull()
    }
  })
})

describe('mounted tools/pre-execute guard', () => {
  it('denies an outside search and delegates unknown tools through the listener', async () => {
    const root = scratch()
    const home = join(root, 'home'); mkdirSync(home)
    const grants: Grant[] = [{ path: home, mode: 'rw' }]
    const ctx = new Context()
    const allow = { kind: 'allow' as const }
    try {
      registerGuard(ctx, () => grants)
      const exec = (name: string, args: Record<string, unknown>, cwd = home) => ({
        name,
        arguments: args,
        agent: { session: { header: { cwd } } },
      })
      const denied = await ctx.waterfall('tools/pre-execute', exec('grep', { path: root }) as never, async () => allow)
      expect(denied).toMatchObject({ kind: 'deny', reason: expect.stringContaining('outside your allowed directories') })
      expect(await ctx.waterfall('tools/pre-execute', exec('grep', { pattern: 'x' }) as never, async () => allow)).toBe(allow)
      expect(await ctx.waterfall('tools/pre-execute', exec('glob', { path: '../' }) as never, async () => allow))
        .toMatchObject({ kind: 'deny' })
      expect(await ctx.waterfall('tools/pre-execute', exec('bash', { command: 'rm -rf /' }) as never, async () => allow)).toBe(allow)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
