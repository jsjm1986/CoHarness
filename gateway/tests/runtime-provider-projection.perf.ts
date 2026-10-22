/** Offline built-Provider work-count diagnostic; it makes no latency or capacity claim. */
import assert from 'node:assert/strict'
import { createProjectionHarness, syntheticProviderRows, type ProjectionOwner, type ProjectionScope } from './runtime-provider-projection.fixture.ts'
import { writePerformanceReport } from './performance-report.ts'

const builtModule = new URL('../lib/postgres/model-governance-service.js', import.meta.url)
const { PostgresModelGovernanceService } = await import(builtModule.href) as { PostgresModelGovernanceService: ProjectionOwner }
const clone = globalThis.structuredClone
let cloneCalls = 0
let clonedModels = 0
globalThis.structuredClone = value => {
  cloneCalls += 1
  const models = (value as { models?: unknown }).models
  if (Array.isArray(models)) clonedModels += models.length
  return clone(value)
}
const samples = []
try {
  for (const scope of ['organization', 'project'] satisfies ProjectionScope[]) {
    for (const count of [16, 64, 256]) {
      const rows = syntheticProviderRows(count)
      const project = createProjectionHarness(PostgresModelGovernanceService)
      cloneCalls = 0
      clonedModels = 0
      const result = await project(scope, rows)
      assert.equal(result.length, 1)
      assert.equal(result[0]!.models.length, count)
      assert.deepEqual(result[0]!.models.map(model => model.id), rows.map(row => row.model_id))
      assert.ok(result[0]!.models.every(model => model.contextWindow === 8192 && model.maxTokens === 1024))
      samples.push({ scope, models: count, providers: result.length, cloneCalls, clonedModels })
    }
  }
} finally { globalThis.structuredClone = clone }
writePerformanceReport({
  schemaVersion: 1, diagnostic: 'runtime-provider-projection-work', execution: 'built',
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  workload: { providerCounts: [1], modelsPerProvider: [16, 64, 256], scopes: ['organization', 'project'] },
  excludes: ['database and JSON decoding', 'authentication', 'network', 'runtime readiness', 'browser rendering'],
  samples,
})
