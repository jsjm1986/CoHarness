/**
 * Language preference row registered into the General section item slot
 * (figma 501:30011 'Setting-Cell'): title + selector pill opening the locale
 * menu. Registered by this package — the locale feature owns its own
 * settings surface.
 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createLanguageRowStore } from './settings-store.ts'
import css from './LanguageRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface LanguageRowInjected {
  /** Switch the active locale (a registered locale id). */
  setLocale: (id: string) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type LanguageRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createLanguageRowStore>>
  & PropsLocale<'settings.locale'> & LanguageRowInjected

/**
 * Render the Language row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function LanguageRow({ t, setLocale, useStore }: LanguageRowComponentProps) {
  const active = useStore(s => s.active)
  const options = useStore(s => s.options)
  const settings = useStore(s => s.settings)
  const [open, setOpen] = useState(false)
  const activeLabel = options.find(o => o.id === active)?.label ?? active
  const disabled = settings.status !== 'ready' || !settings.writable || settings.write.status === 'saving'
  const blocked = settings.write.status === 'blocked' ? settings.write.reason : undefined
  const notice = settings.write.status === 'error'
    ? t('language.saveFailed')
    : settings.write.status === 'saving'
      ? t('language.saving')
      : blocked === 'loading' || settings.status === 'loading'
        ? t('language.loading')
        : blocked === 'unavailable' || settings.status === 'unavailable'
          ? t('language.unavailable')
          : blocked === 'project' || settings.writableReason === 'project'
            ? t('language.projectReadOnly')
            : blocked === 'provider' || settings.writableReason === 'provider'
              ? t('language.providerReadOnly')
              : blocked === 'account' || settings.writableReason === 'account'
                ? t('language.accountReadOnly')
                : blocked === 'organization' || settings.writableReason === 'organization'
                  ? t('language.organizationReadOnly')
                  : blocked === 'deployment' || settings.writableReason === 'deployment'
                    ? t('language.deploymentReadOnly')
                    : undefined

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('language.title')}</div>
        {notice === undefined ? null : (
          <div className={css.notice} role={settings.write.status === 'error' ? 'alert' : 'status'}>
            {notice}
          </div>
        )}
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={options.map(o => ({ id: o.id, label: o.label }))}
        selectedId={active}
        onSelect={(id) => {
          setLocale(id)
          setOpen(false)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => { setOpen(v => !v) }}
          >
            {activeLabel}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
