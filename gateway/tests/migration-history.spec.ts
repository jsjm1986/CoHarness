/** Published migration identities survive branch integration unchanged. */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('keeps the published project journal at version 59 and appends the resource budget', async () => {
  const migrations = resolve(import.meta.dirname, '../deploy/postgres/migrations')
  const names = (await readdir(migrations)).filter(name => /^\d{3}_.*\.sql$/u.test(name))
  expect(names.filter(name => name.startsWith('059_'))).toEqual(['059_project_journal.sql'])
  const journal = await readFile(resolve(migrations, '059_project_journal.sql'))
  expect(createHash('sha256').update(journal).digest('hex'))
    .toBe('f5633d1213202ad0d7d157f7b49105c52e90eccb49c99b0e72c97e0756f43bf8')
  expect(names).toContain('060_organization_digest_model.sql')
  expect(names.filter(name => name.startsWith('061_'))).toEqual(['061_node_resource_budget.sql'])
})
