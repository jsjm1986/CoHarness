/** Source-plane native entry behavior when optional packages or grants are absent. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it } from 'vitest'
import { grantArgs, launcherPath, probe } from '@deepseek-ai/node-addon-system/landlock-run'

it('keeps an unresolved optional platform launcher inside the native package', () => {
  const path = launcherPath(() => { throw new Error('Optional platform package is unavailable') })
  expect(isAbsolute(path)).toBe(true)
  expect(path).toContain(join('node_modules', '@deepseek-ai', `node-addon-system-${process.platform}-${process.arch}`, 'bin', 'landlock-run'))
})

it('grants no paths implicitly and treats a missing executable as unusable with the default deadline', () => {
  expect(grantArgs({})).toEqual([])
  const root = mkdtempSync(join(tmpdir(), 'nalr-missing-probe-'))
  try { expect(probe(join(root, 'not-installed'))).toBe('unusable') }
  finally { rmSync(root, { recursive: true, force: true }) }
})
