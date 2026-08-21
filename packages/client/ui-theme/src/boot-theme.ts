/**
 * Host-rendered theme bootstrap for the browser's pre-plugin interval. Each
 * index response embeds the current durable built-in preference; the browser
 * resolves only `system`, then writes the same DOM fields ui-layout's
 * ThemePresenter owns after the client plugin tree activates.
 */

import { DEFAULT_PREFERENCE, type ThemePreference } from './theme-settings.ts'

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Build the inline script for one schema-validated built-in preference. */
function bootThemeScript(preference: ThemePreference): string {
  return `<script>(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.body.toggleAttribute('data-ds-dark-theme', dark)
})()</script>`
}

/**
 * Insert the theme bootstrap immediately after the opening body tag, before
 * the shell mount and module script. Body-less fragments receive it at the
 * end, where the HTML parser has already synthesized a body.
 * @param html - Raw application index HTML.
 * @param preference - Current Host-backed built-in preference.
 * @returns HTML containing the theme bootstrap.
 */
export function injectBootTheme(
  html: string,
  preference: ThemePreference = DEFAULT_PREFERENCE,
): string {
  const script = bootThemeScript(preference)
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (body === null) return `${html}${script}`
  const at = body.index + body[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}

/**
 * Build the structured body-row form used by the shared webserver renderer.
 * @param preference - the schema-validated persisted theme preference.
 * @returns one body script injection for the shared renderer.
 */
export function bootThemeInjection(preference: ThemePreference = DEFAULT_PREFERENCE): IndexInjection {
  const html = injectBootTheme('<body></body>', preference)
  const body = /<body>([\s\S]*)<\/body>/i.exec(html)?.[1]
  if (body === undefined) throw new Error('client-ui-theme: failed to build theme injection')
  const text = body.replace(/^<script>|<\/script>$/g, '')
  return { kind: 'script', placement: 'body', text }
}
