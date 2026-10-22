/** Synthetic JOIN rows for the PostgreSQL runtime Provider projection. */
import type { ModelProviderProtocol, RuntimeModelProvider } from '../src/model-governance.ts'

export type ProjectionScope = 'organization' | 'project'

export interface SyntheticProviderRow {
  provider: string
  display_name: string
  protocol: ModelProviderProtocol
  base_url: string
  credential_ref: string | null
  profile: Record<string, unknown>
  model_id: string
  model_name: string
}

export interface ProjectionOwner {
  prototype: object
}

interface ProjectionMethods {
  runtimeProviders(queryable: { query(): Promise<{ rows: SyntheticProviderRow[] }> }): Promise<RuntimeModelProvider[]>
  runtimeProjectProviders(
    queryable: { query(): Promise<{ rows: SyntheticProviderRow[] }> },
    internalId: string,
    projectId: number,
  ): Promise<RuntimeModelProvider[]>
}

/**
 * Invoke the real projection with synthetic query results, without credentials or a database.
 * @param owner - Source or built service class; these methods only need its organization identifier.
 * @returns A reusable service-local projection driver, with fresh query rows on each invocation.
 */
export function createProjectionHarness(owner: ProjectionOwner): (
  scope: ProjectionScope, rows: SyntheticProviderRow[],
) => Promise<RuntimeModelProvider[]> {
  const service = Object.create(owner.prototype) as ProjectionMethods
  Object.defineProperty(service, 'context', { value: { organizationId: 'synthetic-organization' } })
  return (scope, rows) => {
    const queryable = { query: async () => ({ rows }) }
    return scope === 'organization'
      ? service.runtimeProviders(queryable)
      : service.runtimeProjectProviders(queryable, 'synthetic-project', 42)
  }
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
    display_name: `Synthetic ${provider}`,
    protocol: 'openai-completions',
    base_url: 'https://example.invalid/v1',
    credential_ref: null,
    profile,
    model_id: model.id,
    model_name: model.name,
  }))
}
