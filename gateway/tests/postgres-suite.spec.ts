/** Every directly database-gated spec must participate in the serialized PostgreSQL command. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('keeps additive organization fixtures from resetting their shared schema', () => {
  const additive = ['steward.spec.ts', 'project-service-postgres.spec.ts', 'project-management-transcript.spec.ts',
    'project-administration-transcript.spec.ts', 'project-deletion-transcript.spec.ts',
    'project-account-admission-transcript.spec.ts', 'project-invitation-admission-transcript.spec.ts', 'project-provisioning-transcript.spec.ts',
    'project-removal-transcript.spec.ts', 'node-resource-budget-postgres.spec.ts', 'runtime-stop-lease-postgres.spec.ts',
    'user-service-postgres.spec.ts', 'user-administration-transcript.spec.ts',
    'runtime-personal-policy-postgres.spec.ts', 'runtime-personal-policy-transcript.spec.ts', 'administrator-runtime-control-transcript.spec.ts',
    'audit-query-transcript.spec.ts',
    'model-administration-postgres.spec.ts', 'model-administration-transcript.spec.ts',
    'sqlite-quota-import.spec.ts',
    'account-preferences-postgres.spec.ts', 'account-preferences-transcript.spec.ts',
    'push-notifications-postgres.spec.ts', 'push-notifications-transcript.spec.ts', 'webhook-administration-transcript.spec.ts', 'webhook-admission-postgres.spec.ts', 'digest-model-administration-transcript.spec.ts', 'digest-model-administration-postgres.spec.ts', 'ssh-administration-transcript.spec.ts', 'ssh-administration-postgres.spec.ts', 'remote-desktop-administration-transcript.spec.ts', 'remote-desktop-authority-postgres.spec.ts', 'node-configuration-administration-transcript.spec.ts', 'node-configuration-authority-postgres.spec.ts', 'maintenance-administration-transcript.spec.ts', 'maintenance-administration-postgres.spec.ts', 'runtime-usage-attribution-transcript.spec.ts', 'workbench-computer-permissions-transcript.spec.ts',
    'model-policy-account-postgres.spec.ts', 'model-policy-authority-transcript.spec.ts']
  expect(additive.filter(file => /DROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?harness\b/iu
    .test(readFileSync(join(import.meta.dirname, file), 'utf8')))).toEqual([])
})

it('includes every directly PostgreSQL-gated suite in test:postgres', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { scripts: Record<string, string> }
  const command = manifest.scripts['test:postgres']!
  const databaseSuites = readdirSync(import.meta.dirname).filter(file => file.endsWith('.spec.ts')
    && /\bprocess\.env\.HGW_TEST_DATABASE_URL\b/.test(readFileSync(join(import.meta.dirname, file), 'utf8')))
  expect(databaseSuites.filter(file => !command.split(/\s+/).includes(`tests/${file}`))).toEqual([])
  expect(command.split(/\s+/)).toContain('--no-file-parallelism')
})

it('validates each configured test database through the driver-aware selector', () => {
  const unvalidated = readdirSync(import.meta.dirname, { recursive: true, encoding: 'utf8' })
    .filter(file => file.endsWith('.ts') || file.endsWith('.mjs'))
    .filter(file => {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8')
      const reads = source.match(/\bprocess\.env\.HGW_TEST_DATABASE_URL\b/gu)?.length ?? 0
      const validations = source.match(/\bpostgresTestDatabaseUrl\s*\(\s*process\.env\.HGW_TEST_DATABASE_URL\s*\)/gu)?.length ?? 0
      return reads !== validations
    })
  expect(unvalidated).toEqual([])
})
