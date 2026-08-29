/** Host-owned opt-in setting for model-selectable subagent delegation. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { assertAllowedModelRoutes, type AllowedModelRoute } from './model-selection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** User preference sampled when a new Agent receives delegation tools. */
    subagentModelSelection: SubagentModelSelectionConfig
  }
}

/** Settings namespace for model-selectable child delegation. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE = settingsNamespace('subagent-model-selection')

/** Stored user preference. */
export interface SubagentModelSelectionSettings {
  enabled: boolean
  allowedModels: AllowedModelRoute[]
}

/** Settings schema exposed to settings clients. */
export const SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA: z<SubagentModelSelectionSettings> = z.object({
  enabled: z.boolean().default(false),
  allowedModels: z.array(z.object({
    provider: z.string().min(1).required(),
    model: z.string().min(1).required(),
  })).default([]),
})

/** Deployment defaults for the opt-in setting. */
export interface Config {
  enabled?: boolean
  allowedModels?: AllowedModelRoute[]
}

/** Singleton settings owner sampled by delegation tools at Agent publication. */
export class SubagentModelSelectionConfig extends Service {
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false),
    allowedModels: z.array(z.object({ provider: z.string().min(1).required(), model: z.string().min(1).required() })).default([]),
  })

  private source: () => SubagentModelSelectionSettings

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'subagentModelSelection')
    const entry: SubagentModelSelectionSettings = {
      enabled: config.enabled ?? false,
      allowedModels: config.allowedModels ?? [],
    }
    this.validate(entry)
    this.source = () => entry
    installSettingsSection(
      ctx,
      SUBAGENT_MODEL_SELECTION_SETTINGS_NAMESPACE,
      SUBAGENT_MODEL_SELECTION_SETTINGS_SCHEMA,
      entry,
      {
        setSource: (source) => { this.source = source },
        validate: (value) => { this.validate(value) },
        onChange: () => {},
      },
    )
  }

  /** Read a detached preference for the next eligible Agent. */
  current(): SubagentModelSelectionSettings {
    const current = this.source()
    return { enabled: current.enabled, allowedModels: current.allowedModels.map(route => ({ ...route })) }
  }

  private validate(value: SubagentModelSelectionSettings): void {
    assertAllowedModelRoutes(value.allowedModels)
    if (value.enabled && value.allowedModels.length === 0) {
      throw new Error('enabled subagent model selection requires at least one allowed model')
    }
  }
}

export const name = 'subagent-model-selection-settings'
export default SubagentModelSelectionConfig
