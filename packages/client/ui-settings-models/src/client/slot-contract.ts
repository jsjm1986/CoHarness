/** Models-page extension slots owned by the settings-models package. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigurableProviderView } from '@deepseek-ai/dsh-api-remotes/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Extension area inside each provider card, keyed by settings namespace. */
    'settings.models.provider-card': {
      kind: 'keyed'
      scope: 'root'
      owner: ProviderCardExtrasOwnerProps
    }
    /** Ordered extension area after the provider list and add controls. */
    'settings.models.footer': {
      kind: 'list'
      scope: 'root'
      owner: ModelsFooterOwnerProps
    }
  }
}

/** Owner share of one provider-card extension occurrence. */
export interface ProviderCardExtrasOwnerProps {
  /** Provider directory entry shown by the card. */
  provider: ConfigurableProviderView
  /** Whether any layer configures this provider. */
  configured: boolean
  /**
   * Whether the credential this page would use is configured: the profile's
   * `apiKeyEnv`, or the page's derived reference while the profile names
   * none — the same reference the row's own editor resolves.
   */
  keyConfigured: boolean
}

/** Owner share of the footer extension area. */
export interface ModelsFooterOwnerProps {
  /** Marker field: the section supplies no footer data. */
  children?: never
}
