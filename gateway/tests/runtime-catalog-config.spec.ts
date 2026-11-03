/** Deployment limits keep environment-directory requests bounded before startup. */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { testConfig } from './test-config.ts'

const root = join(tmpdir(), 'parser-only-runtime-catalog')

it('resolves configurable row and complete-response byte budgets', () => {
  expect(testConfig(root).runtimeCatalog).toEqual({ pageSize: 50, maxBytes: 131072 })
  expect(testConfig(root, { HGW_RUNTIME_CATALOG_PAGE_SIZE: '1', HGW_RUNTIME_CATALOG_MAX_BYTES: '512' }).runtimeCatalog)
    .toEqual({ pageSize: 1, maxBytes: 512 })
})

it.each([
  { HGW_RUNTIME_CATALOG_PAGE_SIZE: '0' },
  { HGW_RUNTIME_CATALOG_PAGE_SIZE: '201' },
  { HGW_RUNTIME_CATALOG_PAGE_SIZE: '1.5' },
  { HGW_RUNTIME_CATALOG_MAX_BYTES: '0' },
  { HGW_RUNTIME_CATALOG_MAX_BYTES: '511' },
])('refuses invalid directory bounds %j', overrides => {
  expect(() => testConfig(root, overrides)).toThrow()
})
