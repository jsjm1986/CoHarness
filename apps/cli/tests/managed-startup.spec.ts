/** Inherited managed launch channels require authorization before the first profile effect. */
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const run = promisify(execFile)
const repo = new URL('../../../', import.meta.url)

it('refuses startup effects in managed file and descriptor launches while preserving independent execution', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const output: string[] = []
  for (const label of ['standalone', 'file', 'descriptor'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-managed-startup-'))
    try {
      const home = join(root, 'home'), dsh = join(root, '.dsh'), profile = join(dsh, 'profiles/startup-probe')
      await mkdir(home); await mkdir(profile, { recursive: true })
      await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-startup-probe', private: true,
        dependencies: {}, dsh: { profile: { bundles: [] } } }))
      const suffix = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
      await writeFile(join(profile, 'cordis.patch.yml'), '- insert:\n'
        + ['packages/llm/llm', 'packages/subprocess/subprocess-local']
          .map(name => `    - name: ${JSON.stringify(new URL(`${name}/${suffix}`, repo).href)}\n`).join('')
        + `    - name: ${JSON.stringify(new URL('./fixtures/managed-startup.mjs', import.meta.url).href)}\n`
        + `      config: ${JSON.stringify({ mode, label, managed: label !== 'standalone' })}\n`)
      if (label === 'file') {
        await writeFile(join(root, 'parent-bootstrap.mjs'), `import assert from 'node:assert/strict'
export function apply(ctx) {
  for (const key of ['modelAccessRequired','resourceBudgetRequired','executionAuthorityRequired']) assert.equal(ctx.get(key),true)
}
`)
      }
      const result = await run(process.execPath, [
        ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
        fileURLToPath(new URL(`apps/cli/${mode === 'src' ? 'src/bin.ts' : 'lib/bin.js'}`, repo)), '--profile', 'startup-probe',
      ], { cwd: root, timeout: 20_000, killSignal: 'SIGKILL', env: {
        PATH: process.env.PATH, HOME: home, USERPROFILE: home, DSH_HOME: dsh, DSH_AGENTS_HOME: join(root, '.agents'),
        ...label === 'file' ? { DSH_GATEWAY_CREDENTIAL_FILE: join(root, 'unavailable-credential.json'),
          DSH_SDK_PARENT_BOOTSTRAP: pathToFileURL(join(root, 'parent-bootstrap.mjs')).href } : {},
        ...label === 'descriptor' ? { DSH_GATEWAY_CREDENTIAL_FD: '3' } : {},
        TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('tsconfig.json', repo)) : undefined,
      } })
      output.push(result.stdout)
    } catch (error) {
      if (error instanceof Error) {
        const failure = error as Error & { stdout?: string; stderr?: string }
        error.message += `\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`
      }
      throw error
    } finally { await rm(root, { recursive: true, force: true }) }
  }
  expect(output.join('')).toBe(await readFile(new URL('./expected/managed-startup.jsonl', import.meta.url), 'utf8'))
}, 60_000)
