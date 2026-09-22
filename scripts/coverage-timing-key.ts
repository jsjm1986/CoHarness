/** Emit the environment-bound timing cache key for GitHub Actions. */
import { resolve } from 'node:path'
import { coverageTimingCacheKey } from './coverage-partitions.ts'

console.log(`key=${coverageTimingCacheKey(resolve(import.meta.dirname, '..'))}`)
