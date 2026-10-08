/** Client compiler inputs retain package declarations and exclude Host-owned Web E2Es. */

import { existsSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Absolute `/`-normalized input filenames a project resolves, honoring its own include/exclude. */
function projectInputs(project: string, overrideExclude?: readonly string[]): string[] {
  const configPath = resolve(root, project)
  const read = ts.readConfigFile(configPath, file => ts.sys.readFile(file))
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  const source: unknown = read.config
  const config = overrideExclude === undefined
    ? source
    : { ...(source as Record<string, unknown>), exclude: [...overrideExclude] }
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, resolve(configPath, '..'))
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  }
  return parsed.fileNames.map(file => file.replaceAll(sep, '/'))
}

/** Host-program e2e roots beneath `apps/web/tests/` at any depth; pure helpers stay shared and client-only e2e files stay absent. */
const HOST_WEB_TEST_PREFIX = `${resolve(root, 'apps/web/tests').replaceAll(sep, '/')}/`
function hostWebE2EInputs(hostInputs: readonly string[]): string[] {
  return hostInputs.filter(file => file.startsWith(HOST_WEB_TEST_PREFIX) && file.endsWith('.e2e.ts'))
}

function clientCssDeclarations(): string[] {
  const clientGroups = ['client', 'extensions']
  return clientGroups.flatMap((group) => {
    const clientRoot = resolve(root, 'packages', group)
    return readdirSync(clientRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => resolve(clientRoot, entry.name, 'src/css-modules.d.ts'))
  })
    .filter(existsSync)
    .map(file => file.replaceAll(sep, '/'))
    .sort()
}

describe('client TypeScript aggregate', () => {
  it('loads package CSS declarations without relying on workspace-link realpaths', () => {
    const loaded = projectInputs('tsconfig.client.json')
      .filter(file => file.endsWith('/src/css-modules.d.ts'))
      .sort()
    expect(loaded).toEqual(clientCssDeclarations())
  })

  it('keeps every Host-owned web e2e root out of the client program', () => {
    const hostCorpus = hostWebE2EInputs(projectInputs('tsconfig.host.json'))
    expect(hostCorpus.length).toBeGreaterThan(0)
    expect(hostCorpus.some(file => file.endsWith('/apps/web/tests/plugin-install-approve.e2e.ts'))).toBe(true)
    const clientInputs = projectInputs('apps/web/tsconfig.json')
    const leaked = hostCorpus.filter(file => clientInputs.includes(file))
    expect(leaked).toEqual([])
  })

  it('admits Host-owned web e2e roots when client exclusions are absent', () => {
    const hostCorpus = hostWebE2EInputs(projectInputs('tsconfig.host.json'))
    const clientWithoutExclude = projectInputs('apps/web/tsconfig.json', [])
    const leaked = hostCorpus.filter(file => clientWithoutExclude.includes(file))
    expect(leaked.length).toBeGreaterThan(0)
  })

  it('selects only the owning directory, not lookalike paths or helper files', () => {
    const inputs = [
      `${HOST_WEB_TEST_PREFIX}direct.e2e.ts`,
      `${HOST_WEB_TEST_PREFIX}nested/deeper.e2e.ts`,
      `${HOST_WEB_TEST_PREFIX}scaffold.ts`,
      `${HOST_WEB_TEST_PREFIX}helper.e2e.json`,
      `${resolve(root, 'scripts/fixtures/apps/web/tests').replaceAll(sep, '/')}/lookalike.e2e.ts`,
      `${resolve(root, 'packages/client/modules/tests').replaceAll(sep, '/')}/other.e2e.ts`,
    ]
    expect(hostWebE2EInputs(inputs)).toEqual([
      `${HOST_WEB_TEST_PREFIX}direct.e2e.ts`,
      `${HOST_WEB_TEST_PREFIX}nested/deeper.e2e.ts`,
    ])
  })
})
