/** General Settings row for Chat HTTP(S) link destinations. */
import { useEffect, useState } from 'react'
import type { ObservableSnapshot, SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LinkOpening } from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import css from './LinkOpeningRow.module.css'

/** Registration-side link-opening preference. */
export interface LinkOpeningRowInjected {
  hooks: {
    /** Current destination bound as useLinkOpening. */
    linkOpening: SnapshotStore<LinkOpening>
    /** Whether the built-in browser is registered, bound as useBrowserAvailable. */
    browserAvailable: ObservableSnapshot<boolean>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the default destination for Chat HTTP(S) links. */
  setLinkOpening: (destination: LinkOpening) => void
}

/** Full Settings-row props. */
export type LinkOpeningRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<LinkOpeningRowInjected>

const OPTIONS: readonly {
  id: LinkOpening
  label: ConversationKey
}[] = [
  { id: 'sidebar', label: 'settings.links.sidebar' },
  { id: 'new-tab', label: 'settings.links.newTab' },
]

/**
 * Render the link-opening destination selector; hidden when the assembly has
 * no built-in browser to point at.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function LinkOpeningRow({ useLinkOpening, useBrowserAvailable, useSettings, setLinkOpening, t }: LinkOpeningRowProps) {
  const destination = useLinkOpening(value => value)
  const browserAvailable = useBrowserAvailable(value => value)
  const settings = useSettings(value => value)
  const [open, setOpen] = useState(false)
  const disabled = settings.status !== 'ready' || !settings.writable || settings.write.status === 'saving'
  const blocked = settings.write.status === 'blocked' ? settings.write.reason : undefined
  /* jscpd:ignore-start -- parallel settings-row surface variants share the
   * notice chain and row layout by design. */
  const notice = settings.write.status === 'error'
    ? t('settings.links.saveFailed')
    : settings.write.status === 'saving'
      ? t('settings.links.saving')
      : blocked === 'loading' || settings.status === 'loading'
        ? t('settings.links.loading')
        : blocked === 'unavailable' || settings.status === 'unavailable'
          ? t('settings.links.unavailable')
          : blocked === 'project' || settings.writableReason === 'project'
            ? t('settings.links.projectReadOnly')
            : blocked === 'provider' || settings.writableReason === 'provider'
              ? t('settings.links.providerReadOnly')
              : blocked === 'account' || settings.writableReason === 'account'
                ? t('settings.links.accountReadOnly')
                : blocked === 'organization' || settings.writableReason === 'organization'
                  ? t('settings.links.organizationReadOnly')
                  : blocked === 'deployment' || settings.writableReason === 'deployment'
                    ? t('settings.links.deploymentReadOnly')
                    : undefined

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  if (!browserAvailable) return null
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('settings.links.title')}</div>
        <div className={css.desc}>{t('settings.links.description')}</div>
        {notice === undefined ? null : (
          <div className={css.notice} role={settings.write.status === 'error' ? 'alert' : 'status'}>
            {notice}
          </div>
        )}
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={destination}
        onSelect={(id) => {
          setOpen(false)
          setLinkOpening(id as LinkOpening)
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
            onClick={() => { setOpen(value => !value) }}
          >
            {t(`settings.links.${destination}` as ConversationKey)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
  /* jscpd:ignore-end */
}
