import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('accepts its own workspace and rejects empty, wrong-target and peer-qualified registry resolutions through the real command', () => {
  const root = mkdtempSync(join(tmpdir(), 'vendored-links-'))
  const repository = resolve(import.meta.dirname, '..')
  try {
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'vendor/cordis'), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    writeFileSync(join(root, 'vendor/cordis/package.json'), '{"name":"@deepseek-ai/cordis"}')
    cpSync(join(repository, 'scripts/verify-vendored-links.ts'), join(root, 'scripts/verify-vendored-links.ts'))
    symlinkSync(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction')
    const lock = (version: string, snapshots = {}): object => ({ importers: {
      '.': { dependencies: { '@deepseek-ai/cordis': { version } } }, 'vendor/cordis': {},
    }, snapshots })
    const run = (data: object) => {
      writeFileSync(join(root, 'pnpm-lock.yaml'), JSON.stringify(data))
      return spawnSync(process.execPath, ['--import', 'tsx/esm', 'scripts/verify-vendored-links.ts'], {
        cwd: root, encoding: 'utf8', timeout: 20_000,
      })
    }
    const valid = run(lock('link:vendor/cordis'))
    expect(valid.status, valid.stderr).toBe(0)
    for (const invalid of [{}, lock('4.0.0'), lock('link:vendor/not-cordis'),
      lock('link:vendor/cordis', { '@deepseek-ai/cordis@4.0.0(peer@1.0.0)': {} })]) {
      const result = run(invalid)
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout).toBe(1)
      expect(result.stderr).toContain('verify-vendored-links:')
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 120_000)
