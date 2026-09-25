import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os, { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {} from '@deepseek-ai/dsh-skill'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-userdoc'
import type { LocalUserDocStore } from '@deepseek-ai/dsh-userdoc-local'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let restoreAmbientHome: (() => void) | undefined
afterEach(() => { restoreAmbientHome?.() })

it('stores documents outside the workspace and leaves ambient documents, locks and legacy uploads untouched', async () => {
  const ambient = await mkdtemp(join(tmpdir(), 'dsh-web-ambient-documents-'))
  const ambientDocument = join(ambient, 'documents', 'keep.txt')
  const legacyUpload = join(ambient, 'uploads', 'legacy.txt')
  const ambientLock = join(ambient, 'documents', '.upload-sessions', 'v1', '.admission.lock')
  let scaffold: WebScaffold | undefined
  let storageRoot: string | undefined
  try {
    await mkdir(dirname(ambientLock), { recursive: true })
    await mkdir(dirname(legacyUpload), { recursive: true })
    await writeFile(ambientDocument, 'ambient document')
    await writeFile(legacyUpload, 'legacy upload')
    await writeFile(ambientLock, `${process.pid}\n`)
    // Loader imports plugins through native ESM. Substitute only the OS home,
    // including native named imports; storage and its lifecycle remain real.
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(ambient)
    restoreAmbientHome = () => {
      homeSpy.mockRestore()
      syncBuiltinESMExports()
      restoreAmbientHome = undefined
    }
    syncBuiltinESMExports()
    scaffold = await launchWebScaffold()
    storageRoot = dirname(scaffold.persistenceRoot)
    const documents = join(storageRoot, 'documents')
    const store = scaffold.ctx.userDocs
    expect((store as LocalUserDocStore).root).toBe(documents)
    expect(relative(scaffold.workspaceCwd, documents).startsWith(`..${sep}`)).toBe(true)
    const target = await store.resolveTarget({ name: 'owned.txt' })
    const ref = await store.save(target, new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('scaffold document'))
        controller.close()
      },
    }))
    expect(dirname(await realpath(ref.path))).toBe(await realpath(documents))
    expect(await readFile(ref.path, 'utf8')).toBe('scaffold document')
    expect((await store.list()).map(item => item.name)).toEqual(['owned.txt'])
    expect(await readFile(ambientDocument, 'utf8')).toBe('ambient document')
    expect(await readFile(legacyUpload, 'utf8')).toBe('legacy upload')
    expect(await readFile(ambientLock, 'utf8')).toBe(`${process.pid}\n`)
  } finally {
    try {
      await scaffold?.close()
    } finally {
      restoreAmbientHome?.()
      await rm(ambient, { recursive: true, force: true })
    }
  }
  if (storageRoot === undefined) throw new Error('scaffold did not allocate private storage')
  await expect(lstat(storageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
})

async function writeSkill(root: string, name: string): Promise<void> {
  const bundle = join(root, name)
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), `---
name: ${name}
description: Must not enter the Web replay scaffold
---

Ambient host state.
`)
}

it('keeps document storage and upload admission inside its owned temporary world', async () => {
  const scaffold = await launchWebScaffold()
  const documentRoot = join(dirname(scaffold.persistenceRoot), 'documents')
  try {
    const documents = scaffold.ctx.get('userDocs')
    if (documents === undefined) throw new Error('the composition mounts no document store')
    const target = await documents.resolveTarget({ name: 'fixture.txt' })
    expect(target.path).toBe(join(documentRoot, 'fixture.txt'))
    const bytes = new TextEncoder().encode('isolated document')
    const saved = await documents.save(target, new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }))
    expect(await readFile(saved.path, 'utf8')).toBe('isolated document')
    expect(await documents.list()).toEqual([saved])
    await expect(readFile(join(scaffold.workspaceCwd, 'user-documents', 'fixture.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await scaffold.close()
  }
  await expect(readFile(join(documentRoot, 'fixture.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('isolates replay skill discovery from every ambient host root', async () => {
  const ambient = await mkdtemp(join(tmpdir(), 'dsh-web-ambient-skills-'))
  const dshHome = join(ambient, 'dsh-home')
  const agentsHome = join(ambient, 'agents-home')
  const bundled = join(ambient, 'bundled')
  await Promise.all([
    writeSkill(join(dshHome, 'skills'), 'ambient-dsh'),
    writeSkill(join(agentsHome, 'skills'), 'ambient-agents'),
    writeSkill(bundled, 'ambient-bundled'),
  ])

  const originalDshHome = process.env.DSH_HOME
  const originalAgentsHome = process.env.DSH_AGENTS_HOME
  const originalBundled = process.env.DSH_BUNDLED_SKILL_DIR
  process.env.DSH_HOME = dshHome
  process.env.DSH_AGENTS_HOME = agentsHome
  process.env.DSH_BUNDLED_SKILL_DIR = bundled
  let scaffold: WebScaffold | undefined
  try {
    scaffold = await launchWebScaffold()
    const ctx = scaffold.ctx
    // Local skill discovery belongs to the agent's preset LAYER of the host
    // registry, so the roots under test are only reachable through a composed
    // agent's view — the same scope the gateway's `skill.list` resolves for a
    // browser request about a session.
    const handle = await ctx.agents.create({
      sessionId: SessionId('hermetic-skills'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      const skills = ctx.get('skills')
      if (skills === undefined) throw new Error('the composition mounts no skill registry')
      const names = (await skills.list({ cwd: scaffold.workspaceCwd, scope: handle.agent })).map(skill => skill.name)
      expect(names).not.toContain('ambient-dsh')
      expect(names).not.toContain('ambient-agents')
      expect(names).not.toContain('ambient-bundled')
      expect(names.toSorted()).toEqual(['office-docx', 'office-pptx', 'office-xlsx'])
    } finally {
      await handle.dispose()
    }
  } finally {
    try {
      await scaffold?.close()
    } finally {
      if (originalDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalDshHome
      if (originalAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
      else process.env.DSH_AGENTS_HOME = originalAgentsHome
      if (originalBundled === undefined) delete process.env.DSH_BUNDLED_SKILL_DIR
      else process.env.DSH_BUNDLED_SKILL_DIR = originalBundled
      await rm(ambient, { recursive: true, force: true })
    }
  }
})

it('recovers document admission through the shipped provider restart and HTTP route', async () => {
  const scaffold = await launchWebScaffold()
  try {
    const documents = scaffold.ctx.get('userDocs')
    if (documents === undefined) throw new Error('the composition mounts no document store')
    await documents.list()
    const lockPath = join(dirname(scaffold.persistenceRoot), 'documents', '.upload-sessions', 'v1', '.admission.lock')
    const exited = await promisify(execFile)(process.execPath, ['-p', 'process.pid'])
    await writeFile(lockPath, exited.stdout, { mode: 0o600 })
    const provider = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'userdoc-local')?.fiber
    if (provider === undefined) throw new Error('the composition mounts no local document provider')
    await provider.restart()
    await scaffold.ctx.loader.await()
    const response = await fetch(new URL('/api/documents', scaffold.baseUrl))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ documents: [] })
    await expect(readFile(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await scaffold.close()
  }
})
