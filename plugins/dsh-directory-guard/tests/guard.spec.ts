import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { afterEach, describe, expect, it } from 'vitest'
import type { Grant } from '../src/grants.ts'
import { decideDeny, type GuardExecution } from '../src/guard.ts'
import { registerGuard } from '../src/dsh-adapter.ts'

const scratchRoots: string[] = []

/** A private scratch root, removed at test end; only this run's roots are tracked. */
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dg-')))
  scratchRoots.push(root)
  return root
}

/** The guard over the local filesystem backend's own resolution. */
async function deny(exec: GuardExecution, grants: readonly Grant[], cwd: string): Promise<string | null> {
  const fs = new LocalFileSystem(new Context(), { cwd, diffBasisMaxBytes: 1024 })
  return decideDeny(exec, grants, cwd, async (path, base) => fs.processPath(await fs.resolve(path, { cwd: base })))
}

afterEach(() => {
  while (scratchRoots.length > 0) rmSync(scratchRoots.pop()!, { recursive: true, force: true })
})

describe('decideDeny', () => {
  it('allows writes inside an rw grant and denies outside', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(await deny({ name: 'write', arguments: { file_path: join(proj, 'a.ts'), content: 'x' } }, grants, root)).toBeNull()
    expect(await deny({ name: 'edit', arguments: { file_path: join(proj, 'a.ts') } }, grants, root)).toBeNull()
    const denied = await deny({ name: 'write', arguments: { file_path: join(root, 'outside.ts'), content: 'x' } }, grants, root)
    expect(denied).toContain('outside.ts')
  })

  it('denies writes to a read-only grant but allows reads there', async () => {
    const root = scratch()
    const docs = join(root, 'docs'); mkdirSync(docs)
    const grants: Grant[] = [{ path: docs, mode: 'ro' }]
    expect(await deny({ name: 'read', arguments: { file_path: join(docs, 'r.md') } }, grants, root)).toBeNull()
    expect(await deny({ name: 'write', arguments: { file_path: join(docs, 'r.md'), content: 'x' } }, grants, root)).not.toBeNull()
  })

  it('handles str_replace_editor commands (view read vs create/str_replace/insert write)', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    expect(await deny({ name: 'str_replace_editor', arguments: { command: 'view', path: join(proj, 'a.ts') } }, grants, root)).toBeNull()
    expect(await deny({ name: 'str_replace_editor', arguments: { command: 'create', path: join(proj, 'a.ts'), file_text: 'x' } }, grants, root)).not.toBeNull()
    expect(await deny({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: join(proj, 'a.ts') } }, grants, root)).not.toBeNull()
  })

  it('denies reads entirely outside any grant', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(await deny({ name: 'read', arguments: { file_path: '/etc/hosts' } }, grants, root)).not.toBeNull()
  })

  it('resolves relative paths against cwd and blocks .. escapes', async () => {
    const root = scratch()
    const home = join(root, 'home'); mkdirSync(home)
    const grants: Grant[] = [{ path: home, mode: 'rw' }]
    expect(await deny({ name: 'write', arguments: { file_path: 'note.txt', content: 'x' } }, grants, home)).toBeNull()
    expect(await deny({ name: 'write', arguments: { file_path: '../escape.txt', content: 'x' } }, grants, home)).not.toBeNull()
  })

  it('delegates (null) for tools without a known path argument', async () => {
    const grants: Grant[] = [{ path: '/x', mode: 'rw' }]
    expect(await deny({ name: 'bash', arguments: { command: 'ls /etc' } }, grants, '/x')).toBeNull()
    expect(await deny({ name: 'web_search', arguments: { query: 'hi' } }, grants, '/x')).toBeNull()
  })

  it('denies when a path argument is missing or not a string', async () => {
    const grants: Grant[] = [{ path: '/x', mode: 'rw' }]
    expect(await deny({ name: 'write', arguments: {} }, grants, '/x')).not.toBeNull()
    expect(await deny({ name: 'read', arguments: { file_path: 123 } }, grants, '/x')).not.toBeNull()
  })

  it('treats grep and glob as reads of their traversal root', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const outside = join(root, 'outside'); mkdirSync(outside)
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    for (const name of ['grep', 'glob']) {
      expect(await deny({ name, arguments: { path: proj, pattern: 'x', include: '*.ts' } }, grants, root)).toBeNull()
      const denied = await deny({ name, arguments: { path: outside, pattern: 'x' } }, grants, root)
      expect(denied).toContain('outside your allowed directories')
      expect(await deny({ name, arguments: { path: '../outside' } }, grants, proj)).not.toBeNull()
    }
  })

  it('defaults a search tool path to the session cwd only when absent', async () => {
    const root = scratch()
    const home = join(root, 'home'); mkdirSync(home)
    const outside = join(root, 'outside'); mkdirSync(outside)
    const grants: Grant[] = [{ path: home, mode: 'rw' }]
    for (const name of ['grep', 'glob']) {
      expect(await deny({ name, arguments: { pattern: 'x' } }, grants, home)).toBeNull()
      expect(await deny({ name, arguments: { pattern: 'x' } }, grants, outside)).not.toBeNull()
      expect(await deny({ name, arguments: { path: '' } }, grants, home)).not.toBeNull()
      expect(await deny({ name, arguments: { path: null } }, grants, home)).not.toBeNull()
      expect(await deny({ name, arguments: { path: 42 } }, grants, home)).not.toBeNull()
    }
  })

  it('blocks a search whose path escapes through a symlinked root', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const outside = join(root, 'outside'); mkdirSync(outside)
    // 'junction' is the unprivileged Windows link type; the target is absolute.
    symlinkSync(outside, join(proj, 'link'), 'junction')
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    for (const name of ['grep', 'glob']) {
      expect(await deny({ name, arguments: { path: join(proj, 'link') } }, grants, root)).not.toBeNull()
      expect(await deny({ name, arguments: { path: join(proj, '..', 'outside') } }, grants, root)).not.toBeNull()
    }
  })

  it('checks tools whose names collide with object prototype members as file_path reads', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    for (const name of ['constructor', 'hasOwnProperty', 'toString']) {
      expect(await deny({ name, arguments: { file_path: join(root, 'escape.ts') } }, grants, root)).not.toBeNull()
      expect(await deny({ name, arguments: { file_path: join(proj, 'ok.ts') } }, grants, root)).toBeNull()
    }
  })

  it('checks read_image and any other file_path tool as a read', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    for (const name of ['read_image', 'future_file_tool']) {
      expect(await deny({ name, arguments: { file_path: join(proj, 'a.png') } }, grants, root)).toBeNull()
      expect(await deny({ name, arguments: { file_path: join(root, 'secret.png') } }, grants, root))
        .toContain('outside your allowed directories')
      expect(await deny({ name, arguments: { file_path: '' } }, grants, root)).not.toBeNull()
    }
  })

  it('checks lsp as a read of both its source file and its workspace', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    expect(await deny({ name: 'lsp', arguments: { action: 'hover', file_path: 'a.ts' } }, grants, proj)).toBeNull()
    expect(await deny({ name: 'lsp', arguments: { action: 'hover', file_path: join(root, 'b.ts') } }, grants, proj)).not.toBeNull()
    expect(await deny({ name: 'lsp', arguments: { action: 'hover', file_path: join(proj, 'a.ts') } }, grants, root)).not.toBeNull()
    expect(await deny({ name: 'lsp', arguments: { action: 'hover' } }, grants, proj)).not.toBeNull()
  })

  it('checks every present file as a read', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'ro' }]
    expect(await deny({ name: 'present', arguments: { files: [{ path: 'a.md' }] } }, grants, proj)).toBeNull()
    expect(await deny({ name: 'present', arguments: { files: [{ path: 'a.md' }, { path: join(root, 'b.md') }] } }, grants, proj)).not.toBeNull()
    expect(await deny({ name: 'present', arguments: { files: [{}] } }, grants, proj)).not.toBeNull()
    expect(await deny({ name: 'present', arguments: {} }, grants, proj)).not.toBeNull()
  })

  it('classifies a symlink followed by .. at the physical target the backend opens', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const outside = join(root, 'outside'); mkdirSync(outside)
    const deep = join(outside, 'deep'); mkdirSync(deep)
    writeFileSync(join(outside, 'secret.txt'), 'x')
    writeFileSync(join(proj, 'secret.txt'), 'x')
    // 'junction' is the unprivileged Windows link type; the target is absolute.
    symlinkSync(deep, join(proj, 'link'), 'junction')
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    // Lexically `proj/link/../secret.txt` is `proj/secret.txt`; physically it is `outside/secret.txt`.
    // Template literals keep the `..` that `path.join` would collapse.
    const escaped = `${proj}/link/../secret.txt`
    expect(await deny({ name: 'read', arguments: { file_path: escaped } }, grants, root)).toContain(join(outside, 'secret.txt'))
    expect(await deny({ name: 'read_image', arguments: { file_path: 'link/../secret.txt' } }, grants, proj)).not.toBeNull()
    expect(await deny({ name: 'write', arguments: { file_path: escaped, content: 'x' } }, grants, root)).not.toBeNull()
    expect(await deny({ name: 'edit', arguments: { file_path: `${proj}/link/../new.txt` } }, grants, root)).not.toBeNull()
    expect(await deny({ name: 'grep', arguments: { path: `${proj}/link/..` } }, grants, root)).not.toBeNull()
  })

  it('denies a path the filesystem backend cannot resolve', async () => {
    const root = scratch()
    const proj = join(root, 'proj'); mkdirSync(proj)
    const grants: Grant[] = [{ path: proj, mode: 'rw' }]
    expect(await deny({ name: 'write', arguments: { file_path: `${proj}/missing/../a.txt`, content: 'x' } }, grants, root))
      .toContain('cannot be resolved')
  })
})

describe('mounted tools/pre-execute guard', () => {
  it('resolves through ctx.fs from the Session working directory and delegates unknown tools', async () => {
    const root = scratch()
    const home = join(root, 'home'); mkdirSync(home)
    const outside = join(root, 'outside'); mkdirSync(outside)
    mkdirSync(join(outside, 'deep'))
    writeFileSync(join(outside, 'secret.png'), 'x')
    symlinkSync(join(outside, 'deep'), join(home, 'link'), 'junction')
    const grants: Grant[] = [{ path: home, mode: 'rw' }]
    const ctx = new Context()
    const allow = { kind: 'allow' as const }
    try {
      await ctx.plugin(LocalFileSystem, { cwd: root })
      ctx.provide('workingDirectory', { ensure: async () => home } as never)
      registerGuard(ctx, () => grants)
      const exec = (name: string, args: Record<string, unknown>) => ({
        name,
        arguments: args,
        agent: { session: { header: { cwd: outside } } },
        signal: new AbortController().signal,
      })
      const run = (name: string, args: Record<string, unknown>) =>
        ctx.waterfall('tools/pre-execute', exec(name, args) as never, async () => allow)
      expect(await run('grep', { path: root })).toMatchObject({ kind: 'deny', reason: expect.stringContaining('outside your allowed directories') })
      expect(await run('grep', { pattern: 'x' })).toBe(allow)
      expect(await run('glob', { path: '../' })).toMatchObject({ kind: 'deny' })
      expect(await run('read_image', { file_path: 'link/../secret.png' })).toMatchObject({ kind: 'deny' })
      expect(await run('read_image', { file_path: 'a.png' })).toBe(allow)
      expect(await run('bash', { command: 'rm -rf /' })).toBe(allow)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
