import type {
  CredentialInfo,
  CredentialRef,
  ReadOnlyCredentialLayer,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import type { ModelProviderConfig } from '@deepseek-ai/dsh-model-provider-config'

type OrganizationCredentialResponse = { configured: false } | { configured: true; value: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function organizationCredentialResponse(value: unknown): OrganizationCredentialResponse {
  const response = record(value)
  if (response?.configured === false && response.value === undefined) return { configured: false }
  if (response?.configured === true && typeof response.value === 'string' && response.value.length > 0) {
    return { configured: true, value: response.value }
  }
  throw new Error('model-governance: invalid organization credential response')
}

/** Gateway-backed read-only credentials named by the active managed Provider snapshot. */
export class OrganizationCredentialLayer implements ReadOnlyCredentialLayer {
  readonly id = 'managed-model-providers'

  constructor(
    private readonly gateway: Pick<GatewayRuntime, 'request'>,
    private readonly providers: Pick<ModelProviderConfig, 'snapshot'>,
  ) {}

  /** @inheritdoc */
  owns(ref: CredentialRef): boolean {
    return this.providers.snapshot().providers.some(provider => provider.credentialRef === ref)
  }

  /** @inheritdoc */
  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const credential = await this.fetch(ref)
    return credential.configured
      ? { value: credential.value, source: this.sourceOf(ref) }
      : undefined
  }

  /** @inheritdoc */
  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const credential = await this.fetch(ref)
    return {
      configured: credential.configured,
      ...credential.configured ? { source: this.sourceOf(ref) } : {},
      writable: false,
    }
  }

  private async fetch(ref: CredentialRef): Promise<OrganizationCredentialResponse> {
    if (!this.owns(ref)) {
      throw new Error(`model-governance: credential reference "${ref}" is not owned by a managed Provider`)
    }
    const response = await this.gateway.request('/internal/runtime/model-credential', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref }),
    })
    if (!response.ok) {
      throw new Error(`model-governance: managed credential request failed with HTTP ${String(response.status)}`)
    }
    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error('model-governance: managed credential response is not valid JSON')
    }
    return organizationCredentialResponse(value)
  }

  /** Return the source label used for usage attribution and UI diagnostics. */
  private sourceOf(ref: CredentialRef): 'organization' | 'project' {
    return String(ref).startsWith('DSH_PROJECT_') ? 'project' : 'organization'
  }
}
