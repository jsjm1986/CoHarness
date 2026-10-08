/**
 * Installed-package verification semantics: a published artifact carries no development
 * inputs, so its `run` needs an explicit verifier opt-out, while a normal workspace
 * invocation lets pnpm verify and prepare dependencies first.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const pnpmPackageJson = createRequire(import.meta.url).resolve('pnpm')
const pnpmMjs = join(dirname(pnpmPackageJson), 'bin', 'pnpm.mjs')

const owned = new Set<string>()
afterEach(async () => {
  const pending = [...owned]
  owned.clear()
  await Promise.all(pending.map(root => rm(root, { recursive: true, force: true })))
}, 30_000)

/** One private canonical workspace with the installed-package fixture and its file: dev dependency. */
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-installed-artifact-')))
  owned.add(root)
  const pkg = join(root, 'app')
  const devdep = join(root, 'devdep')
  mkdirSync(pkg, { recursive: true })
  mkdirSync(devdep, { recursive: true })
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({
    name: 'native-artifact-fixture',
    version: '1.0.0',
    private: true,
    devDependencies: { 'artifact-prepare-fixture': 'file:../devdep' },
    scripts: { prepare: 'node prepare.cjs', install: 'node install.cjs' },
  }, null, 2)}\n`)
  writeFileSync(join(devdep, 'package.json'), `${JSON.stringify({
    name: 'artifact-prepare-fixture',
    version: '1.0.0',
  }, null, 2)}\n`)
  writeFileSync(join(pkg, 'prepare.cjs'), 'require("node:fs").writeFileSync("prepare-ran.txt", "prepared")\nprocess.exit(1)\n')
  writeFileSync(join(pkg, 'install.cjs'), 'require("node:fs").writeFileSync("native-built.txt", "built")\n')
  writeFileSync(join(pkg, 'pnpm-workspace.yaml'), 'packages: []\noffline: true\nstoreDir: ../store\n')
  return pkg
}

interface PnpmRunResult {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

async function run(args: readonly string[], cwd: string, signal: AbortSignal): Promise<PnpmRunResult> {
  // `pnpm exec vitest` inherits pnpm's own verify-deps-before-run=false override for
  // its command children; top-level CI shells have no such inherited opt-out.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'pnpm_config_verify_deps_before_run'),
  )
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [pnpmMjs, ...args], {
      cwd, env: { ...env, CI: 'true' }, signal, timeout: 10_000,
    })
    return { status: 0, signal: null, stdout, stderr }
  } catch (error) {
    if (signal.aborted) throw error
    const failure = error as { code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown }
    if (failure.code === 'ABORT_ERR') throw error
    if (failure.killed === true || typeof failure.signal === 'string') {
      throw new Error(`pnpm run aborted or timed out instead of completing: signal=${String(failure.signal)}`)
    }
    if (typeof failure.code !== 'number') throw error
    return {
      status: failure.code,
      signal: null,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
    }
  }
}

describe('pnpm installed-artifact dependency verification', () => {
  it('without automatic verification', async ({ signal }) => {
    const pkg = fixture()
    const result = await run(['--config.verify-deps-before-run=false', 'run', 'install'], pkg, signal)
    expect(result.status).toBe(0)
    expect(result.signal).toBeNull()
    expect(existsSync(join(pkg, 'native-built.txt'))).toBe(true)
    expect(existsSync(join(pkg, 'prepare-ran.txt'))).toBe(false)
  }, 30_000)

  it('default verification attempts source preparation', async ({ signal }) => {
    const pkg = fixture()
    const result = await run(['run', 'install'], pkg, signal)
    console.log(JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }))
    expect(result.signal).toBeNull()
    expect(existsSync(join(pkg, 'prepare-ran.txt'))).toBe(true)
  }, 30_000)
})
