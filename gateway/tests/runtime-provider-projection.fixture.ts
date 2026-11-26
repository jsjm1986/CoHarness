/** Synthetic JOIN rows for the PostgreSQL runtime Provider projection. */
import type { ModelProviderProtocol, RuntimeModelProvider } from '../src/model-governance.ts'
import { runtimePolicyFromRows } from '../src/postgres/model-governance-service.ts'

export type ProjectionScope = 'organization' | 'project'

export interface SyntheticProviderRow {
  provider: string
  model: string
  provider_enabled: boolean
  model_enabled: boolean
  allowed: boolean
  project_owned: boolean
  display_name: string
  protocol: ModelProviderProtocol
  base_url: string
  credential_ref: string | null
  profile: Record<string, unknown>
  model_name: string
}

/**
 * Invoke the real projection with synthetic query results, without credentials or a database.
 * @param project - Projection implementation; the source export by default, the built lib for diagnostics.
 * @returns A reusable projection driver, with fresh query rows on each invocation.
 */
export function createProjectionHarness(project: typeof runtimePolicyFromRows = runtimePolicyFromRows): (
  scope: ProjectionScope, rows: SyntheticProviderRow[],
) => Promise<RuntimeModelProvider[]> {
  return async (scope, rows) => project(1, rows.map(row => ({
    ...row,
    project_owned: scope === 'project',
  })), scope === 'project' ? 42 : undefined).providers
}

/**
 * Build one Provider profile repeated by its catalog JOIN, using no external inputs.
 * @param count - Enabled catalog model count and configured profile model count.
 * @param provider - Synthetic Provider identifier.
 * @returns Ordered rows sharing the same JSON profile, as a JOIN over one Provider does.
 */
export function syntheticProviderRows(count: number, provider = 'synthetic-provider'): SyntheticProviderRow[] {
  const models = Array.from({ length: count }, (_, index) => ({
    id: `synthetic-${index}`,
    name: `Synthetic ${index}`,
    contextWindow: 8192,
    maxTokens: 1024,
    input: ['text'],
  }))
  const profile = { models }
  return models.map(model => ({
    provider,
    model: model.id,
    provider_enabled: true,
    model_enabled: true,
    allowed: true,
    project_owned: false,
    display_name: `Synthetic ${provider}`,
    protocol: 'openai-completions',
    base_url: 'https://example.invalid/v1',
    credential_ref: null,
    profile,
    model_name: model.name,
  }))
}
