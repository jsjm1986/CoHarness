/** Verifies the Host's published release identity in the actual Node build face. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'tsdown'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function releaseFixture(commit: string | undefined): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-client-host-release-'))
  try {
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', commit)
    vi.resetModules()
    const { default: preset } = await import('../packages/client/modules/tsdown.config.ts')
    const config = preset({ env: { DSH_BUILD_FACE: 'client' } }).find(config => config.platform === 'node')
    if (config === undefined) throw new Error('Host Node build missing')
    await mkdir(join(root, 'lib/types'), { recursive: true })
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(root, 'lib/types/index.js'), [
      'export function release() {',
      '  const commit = process.env.DSH_CLIENT_COMMIT_HASH;',
      '  return { version: "fixture", commit, runtime: process.env.DSH_HOST_RELEASE_TEST };',
      '}',
    ].join('\n') + '\n')
    await build({ ...config, config: false, cwd: root, outDir: join(root, 'out'), tsconfig: false, logLevel: 'silent', report: false })
    for (const runtimeCommit of [undefined, 'conflicting-runtime']) {
      const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOST_RELEASE_TEST: runtimeCommit ?? 'runtime-without-commit' }
      delete env.DSH_CLIENT_COMMIT_HASH
      if (runtimeCommit !== undefined) env.DSH_CLIENT_COMMIT_HASH = runtimeCommit
      const result = execFileSync(process.execPath, ['--input-type=module', '-e',
        'import("./out/index.js").then(({release}) => process.stdout.write(JSON.stringify(release())))',
      ], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      expect(JSON.parse(result)).toEqual({
        version: 'fixture', ...(commit === undefined ? {} : { commit }),
        runtime: runtimeCommit ?? 'runtime-without-commit',
      })
    }
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
}

describe('built Host release identity', () => {
  it('keeps its source commit when launch environment is absent or different', async () => {
    await releaseFixture('0123456')
  })

  it('keeps an unversioned local artifact unversioned while preserving other runtime reads', async () => {
    await releaseFixture(undefined)
  })
})
