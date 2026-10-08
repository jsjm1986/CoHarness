/** Verify resolved Vitest versions shared by workspace test runners and mock helpers. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load as parseYaml } from 'js-yaml'

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`dependency-cohorts: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function resolvedVersion(value: unknown, label: string): string {
  const entry = record(value, label)
  const raw = entry['version']
  if (typeof raw !== 'string') {
    throw new Error(`dependency-cohorts: ${label}.version must name a resolved registry package`)
  }
  const version = raw.split('(')[0] ?? ''
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`dependency-cohorts: ${label}.version must name a resolved registry package, got ${raw}`)
  }
  return version
}

/**
 * Check directly declared Vitest family members against the root runner's resolved version.
 * @param root - Workspace root containing pnpm-lock.yaml.
 * @returns Importer-specific mismatches; missing or uninterpretable lockfile records throw.
 */
export function collectDependencyCohortViolations(root: string): string[] {
  const lock = record(parseYaml(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')), 'pnpm-lock.yaml')
  const importers = record(lock['importers'], 'pnpm-lock.yaml importers')
  const rootImporter = record(importers['.'], 'pnpm-lock.yaml importer .')
  const rootDev = record(rootImporter['devDependencies'], 'pnpm-lock.yaml importer . devDependencies')
  const expected = resolvedVersion(rootDev['vitest'], 'pnpm-lock.yaml importer . devDependencies.vitest')
  const errors: string[] = []
  for (const [dir, value] of Object.entries(importers)) {
    const importer = record(value, `pnpm-lock.yaml importer ${dir}`)
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      if (importer[section] === undefined) continue
      const dependencies = record(importer[section], `pnpm-lock.yaml importer ${dir} ${section}`)
      for (const [name, entry] of Object.entries(dependencies)) {
        if (name !== 'vitest' && !name.startsWith('@vitest/')) continue
        const label = `pnpm-lock.yaml importer ${dir} ${section}.${name}`
        const version = resolvedVersion(entry, label)
        if (version !== expected) {
          errors.push(`dependency-cohorts: ${label} resolves ${version}, but root Vitest resolves ${expected}; update the Vitest family together`)
        }
      }
    }
  }
  return errors
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] === undefined ? resolve(import.meta.dirname, '..') : resolve(process.argv[2])
  const errors = collectDependencyCohortViolations(root)
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  }
}
