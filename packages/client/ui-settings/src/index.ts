/** Host loader entry for the browser implementation exported from `./client`. */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { DEVELOPER_TOOLS_NAMESPACE, DeveloperToolsSettingsSchema } from './developer-tools-settings.ts'

export {
  DEVELOPER_TOOLS_NAMESPACE, DeveloperToolsSettingsSchema, type DeveloperToolsSettings,
} from './developer-tools-settings.ts'

/**
 * Register the durable developer-tool preference section when a settings
 * provider exists.
 * @param ctx - Host context whose optional settings service owns the section.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(
      settingsNamespace(DEVELOPER_TOOLS_NAMESPACE),
      DeveloperToolsSettingsSchema,
    )
  })
}
