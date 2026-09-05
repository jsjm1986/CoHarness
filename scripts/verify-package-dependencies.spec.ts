import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectPackageDependencyViolations,
  readWorkspaceDependencyManifests,
  verifyPackageDependencies,
} from './verify-package-dependencies.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/* jscpd:ignore-start */
function writeJson(root: string, path: string, value: unknown): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
}
/* jscpd:ignore-end */

function fixture(
  manifest: Record<string, unknown>,
  source = '',
): string {
  const root = mkdtempSync(join('/tmp', 'dsh-package-dependencies-'))
  roots.push(root)
  writeJson(root, 'packages/core/example/package.json', {
    name: '@deepseek-ai/dsh-example',
    version: '0.0.1',
    ...manifest,
  })
  if (source !== '') {
    mkdirSync(join(root, 'packages/core/example/src'), { recursive: true })
    writeFileSync(join(root, 'packages/core/example/src/index.ts'), source)
  }
  writeJson(root, 'packages/core/dependency/package.json', {
    name: '@deepseek-ai/dsh-dependency',
    version: '0.0.1',
  })
  return root
}

describe('workspace manifest discovery', () => {
  it('normalizes paths and reads nested package names', () => {
    const root = fixture({})
    expect(readWorkspaceDependencyManifests(root).map(pkg => pkg.name)).toEqual([
      '@deepseek-ai/dsh-dependency',
      '@deepseek-ai/dsh-example',
    ])
  })
})

describe('dependency policy', () => {
  it('accepts a runtime peer mirrored by the development range', () => {
    const root = fixture({
      peerDependencies: {
        '@deepseek-ai/dsh-dependency': 'workspace:^',
        '@deepseek-ai/cordis': 'workspace:^',
      },
      devDependencies: {
        '@deepseek-ai/dsh-dependency': 'workspace:^',
        '@deepseek-ai/cordis': 'workspace:^',
      },
    }, "import type { X } from '@deepseek-ai/dsh-dependency'\n")
    expect(collectPackageDependencyViolations(root)).toEqual([])
  })

  it('requires runtime workspace imports in a production dependency section', () => {
    const root = fixture({
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      devDependencies: {
        '@deepseek-ai/cordis': 'workspace:^',
        '@deepseek-ai/dsh-dependency': 'workspace:^',
      },
    }, "import { value } from '@deepseek-ai/dsh-dependency'\nvoid value\n")
    expect(collectPackageDependencyViolations(root)).toEqual([
      expect.stringContaining('runtime import @deepseek-ai/dsh-dependency is absent'),
    ])
  })

  it('rejects duplicate production declarations and an unmirrored peer', () => {
    const root = fixture({
      dependencies: { '@deepseek-ai/dsh-dependency': 'workspace:^' },
      peerDependencies: {
        '@deepseek-ai/dsh-dependency': 'workspace:^',
        '@deepseek-ai/cordis': 'workspace:^',
      },
      devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    })
    const violations = collectPackageDependencyViolations(root)
    expect(violations).toHaveLength(2)
    expect(violations.join('\n')).toContain('multiple production sections')
    expect(violations.join('\n')).toContain('peerDependencies.@deepseek-ai/dsh-dependency')
  })

  it('rejects a workspace range that would survive packing unchanged', () => {
    const root = fixture({
      dependencies: { '@deepseek-ai/dsh-dependency': '^0.0.1' },
      peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      devDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
    })
    expect(collectPackageDependencyViolations(root)).toEqual([
      expect.stringContaining('must use the workspace: protocol'),
    ])
  })
})

describe('repository check', () => {
  it('passes the current workspace without modifying it', () => {
    const summary = verifyPackageDependencies(process.cwd())
    expect(summary.packageCount).toBeGreaterThan(0)
    expect(summary.runtimeEdgeCount).toBeGreaterThan(0)
  }, 30_000)
})
