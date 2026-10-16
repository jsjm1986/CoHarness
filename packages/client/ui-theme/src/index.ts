/** Host registration for the browser theme preference and pre-plugin palette. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { bootThemeInjections, injectBootTheme } from './boot-theme.ts'
import {
  DEFAULT_PREFERENCE, FONT_SIZE_SPECS, THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema,
  type FontFamilies, type FontSizes, type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

export {
  DEFAULT_PREFERENCE, THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

const THEME_NAMESPACE = settingsNamespace(THEME_SETTINGS_NAMESPACE)

/** Snapshot the durable theme section, or schema defaults without a settings provider. */
function readSettings(ctx: Context): { preference: ThemePreference; fontSizes: FontSizes; fontFamilies: FontFamilies } {
  const settings = ctx.get('settings')
  const section = settings === undefined ? undefined : settings.get(THEME_NAMESPACE) as ThemeSettings | undefined
  return {
    preference: section?.preference ?? DEFAULT_PREFERENCE,
    fontSizes: {
      text: section?.fontSize ?? FONT_SIZE_SPECS.text.default,
      code: section?.codeFontSize ?? FONT_SIZE_SPECS.code.default,
      terminal: section?.terminalFontSize ?? FONT_SIZE_SPECS.terminal.default,
    },
    fontFamilies: {
      text: section?.textFontFamily ?? '',
      code: section?.codeFontFamily ?? '',
      terminal: section?.terminalFontFamily ?? '',
    },
  }
}

/**
 * Register the durable theme section and initial-theme index transform when
 * their optional Host services are composed.
 * @param ctx - Host context that may acquire settings and HTTP services.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema, {
      owner: 'account', projectWrite: 'never',
    })
  })
  ctx.inject(['webServer'], (httpCtx) => {
    if (typeof httpCtx.webServer.renderIndex === 'function') {
      httpCtx.on('webserver/index-inject', (table) => {
        const { preference, fontSizes, fontFamilies } = readSettings(ctx)
        table.push(...bootThemeInjections(preference, fontSizes, fontFamilies))
      })
    } else {
      httpCtx.effect(
        () => httpCtx.webServer.tapIndex((html) => {
          const { preference, fontSizes, fontFamilies } = readSettings(ctx)
          return injectBootTheme(html, preference, fontSizes, fontFamilies)
        }),
        'client-ui-theme: legacy initial theme bootstrap',
      )
    }
  })
}
