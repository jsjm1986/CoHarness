/** Check the active Vitest exclusions without constructing a second exclusion list. */
import { resolve } from 'node:path'
import { repositoryCoveragePolicy } from './coverage-policy.ts'
import { staleCoverageExclusions } from './coverage-selection.ts'

const root = resolve(import.meta.dirname, '..')
const stale = staleCoverageExclusions(root, repositoryCoveragePolicy())
if (stale.length > 0) {
  console.error('verify-coverage-exclusions: exclusions match no measured source:\n' + stale.join('\n'))
  process.exitCode = 1
} else {
  console.log('verify-coverage-exclusions: all persistent exclusions match current source.')
}
