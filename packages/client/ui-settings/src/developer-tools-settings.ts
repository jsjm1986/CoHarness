/** Shared Web developer-tool preference stored by the Host. */
import z from '@deepseek-ai/schemastery'

/** Settings namespace for developer UI capabilities owned by the settings domain. */
export const DEVELOPER_TOOLS_NAMESPACE = 'ui-settings'

/** Persisted developer-tool choice. */
export interface DeveloperToolsSettings {
  /** Enable diagnostic views, preset selection, and changed-file code diffs. */
  enabled: boolean
}

/** New installations and missing values enable the full interface. */
export const DeveloperToolsSettingsSchema: z<DeveloperToolsSettings> = z.object({
  enabled: z.boolean().default(true),
})
