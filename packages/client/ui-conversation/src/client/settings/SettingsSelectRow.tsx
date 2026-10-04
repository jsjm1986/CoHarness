/** Shared General-Settings preference row: title/description, write-state notice, and a Menu selector pill. */
import { useEffect, useState } from 'react'
import type { SettingsControlState } from '@deepseek-ai/dsh-client-runtime/client'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationKey } from '../locales.ts'
import css from './SettingsSelectRow.module.css'

/** Locale namespace of one selector row's copy. */
export type SettingsSelectRowPrefix =
  | 'settings.enter'
  | 'settings.links'
  | 'settings.performance'
  | 'settings.transcript'

type NoticeSuffix =
  | 'saveFailed' | 'saving' | 'loading' | 'unavailable'
  | 'projectReadOnly' | 'providerReadOnly' | 'accountReadOnly'
  | 'organizationReadOnly' | 'deploymentReadOnly'

/**
 * Render one Settings preference selector row.
 * @param props - row copy namespace, live settings state, options, and the selection callback.
 * @returns the preference row.
 */
export function SettingsSelectRow({ prefix, settings, options, selectedId, onSelect, t }: {
  prefix: SettingsSelectRowPrefix
  settings: SettingsControlState
  options: readonly { id: string; label: ConversationKey }[]
  selectedId: string
  onSelect: (id: string) => void
  t: (key: ConversationKey) => string
}) {
  const [open, setOpen] = useState(false)
  const disabled = settings.status !== 'ready' || !settings.writable || settings.write.status === 'saving'
  const blocked = settings.write.status === 'blocked' ? settings.write.reason : undefined
  const statusKey: NoticeSuffix | undefined = settings.write.status === 'error'
    ? 'saveFailed'
    : settings.write.status === 'saving'
      ? 'saving'
      : blocked === 'loading' || settings.status === 'loading'
        ? 'loading'
        : blocked === 'unavailable' || settings.status === 'unavailable'
          ? 'unavailable'
          : blocked === 'project' || settings.writableReason === 'project'
            ? 'projectReadOnly'
            : blocked === 'provider' || settings.writableReason === 'provider'
              ? 'providerReadOnly'
              : blocked === 'account' || settings.writableReason === 'account'
                ? 'accountReadOnly'
                : blocked === 'organization' || settings.writableReason === 'organization'
                  ? 'organizationReadOnly'
                  : blocked === 'deployment' || settings.writableReason === 'deployment'
                    ? 'deploymentReadOnly'
                    : undefined
  const notice = statusKey === undefined ? undefined : t(`${prefix}.${statusKey}`)
  const selectedLabel = options.find(option => option.id === selectedId)?.label

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t(`${prefix}.title`)}</div>
        <div className={css.desc}>{t(`${prefix}.description`)}</div>
        {notice === undefined ? null : (
          <div className={css.notice} role={settings.write.status === 'error' ? 'alert' : 'status'}>
            {notice}
          </div>
        )}
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={options.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={selectedId}
        onSelect={(id) => {
          setOpen(false)
          onSelect(id)
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
            {selectedLabel === undefined ? selectedId : t(selectedLabel)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
