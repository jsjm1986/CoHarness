/** Register the remote-desktop administration settings section. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-desktop-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { RemoteDesktopAdminController } from './admin-store.ts'
import { RemoteDesktopSection, type RemoteDesktopAdminInjected } from './RemoteDesktopSection.tsx'
import { en, zh } from './locales.ts'

/** Services needed by the remote-desktop administration section. */
export const inject = ['slots', 'locale', 'remoteDesktops', 'sessions']

/**
 * Register the `settings.section` contribution: grants table, issue form, and
 * audit tail bound to the caller's active Session for Remote authority.
 * @param ctx - Client root Context with slot, locale, remote-desktop, and sessions services.
 */
export function apply(ctx: Context): void {
  const namespace = 'remoteDesktopAdmin'
  const t = ctx.locale.bind(namespace) as RemoteDesktopAdminInjected['t']
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-remote-desktop-admin.copy')
  const controller = new RemoteDesktopAdminController(
    ctx.remoteDesktops,
    () => ctx.sessions.list.getSnapshot().current,
  )
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-desktop',
    order: 60,
    label: () => t('nav'),
    inject: (): RemoteDesktopAdminInjected => ({
      hooks: { admin: controller.store },
      t,
      refresh: (includeRevoked, signal) => controller.refresh(includeRevoked, signal),
      grant: (input, signal) => controller.grant(input, signal),
      revoke: (grantId, signal) => controller.revoke(grantId, signal),
      setLevel: (grantId, level, signal) => controller.setLevel(grantId, level, signal),
    }),
  }, RemoteDesktopSection)), 'ui-remote-desktop-admin.section')
}
