import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { permissionUnavailableReason, type PermissionAvailability } from '@deepseek-ai/dsh-client-runtime/client'
import type { PermissionCatalog, PermissionSelection as PermissionSelectValue } from '@deepseek-ai/dsh-permission-presets/client'
import { IconChevronDownOutline14, IconFilePenOutline16, IconShieldAlertOutline16, IconShieldCheckOutline16, Menu, RiskConfirmation, useMediaQuery } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerBarProps } from '../contract/slots.ts'
import css from './PermissionSelect.module.css'

type Presentation = 'trigger' | 'section'

const FULL_ACCESS = 'danger-full-access'

/* Shield glyphs (design set 1556): check = read-only, pencil = workspace
   write, exclamation = full access. currentColor so the trigger and menu
   rows tint them with their own text color. */


const permissionGlyphs = {
  'read-only': <IconShieldCheckOutline16 aria-hidden />,
  'workspace-write': <IconFilePenOutline16 aria-hidden />,
  [FULL_ACCESS]: <IconShieldAlertOutline16 aria-hidden />,
} as Record<string, ReactNode>

/** Glyph for a permission option value; host-configured names outside the design set get none. */
function permissionGlyph(value: string): ReactNode | undefined {
  return permissionGlyphs[value]
}

/**
 * Display transform: kebab-case machine names render as title-case labels
 * (`workspace-write` → `Workspace Write`); non-kebab host-configured names
 * pass through. Full access intentionally overrides the machine-name
 * transform so both permission surfaces use the product label `Full access`;
 * the warning body remains locale-aware.
 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function optionLabel(
  option: PermissionCatalog['options'][number],
  t: ComposerBarProps['t'],
): string {
  if (option.value === 'read-only') return t('access.preset.readOnly')
  if (option.value === 'workspace-write') return t('access.preset.workspaceWrite')
  if (option.value === FULL_ACCESS) return t('access.preset.fullAccess')
  return displayName(option.name)
}

export interface PermissionSelectProps {
  value: PermissionSelectValue | undefined
  /** Process-level option table; `undefined` while the remote catalog read is unsettled. */
  catalog: PermissionCatalog | undefined
  /** Eligibility for the current account and this control's runtime target. */
  availability: PermissionAvailability
  locked: boolean
  command: (line: string) => Promise<boolean>
  /** The owning bar's locale seat, passed down as a plain prop. */
  t: ComposerBarProps['t']
  presentation?: Presentation
  onOpenSettings?: (section: 'model' | 'reasoning' | 'permission') => void
}

export function PermissionSelect({ value, catalog, availability, locked, command, t, presentation = 'trigger', onOpenSettings }: PermissionSelectProps) {
  const [pick, setPick] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const phone = useMediaQuery('(max-width: 767px)')

  useEffect(() => {
    if (!locked && value !== undefined) return
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(null)
  }, [locked, value])

  useEffect(() => {
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(null)
  }, [availability])

  if (value === undefined || catalog === undefined) return null

  const currentValue = pick ?? value.currentValue
  const current = catalog.options.find(option => option.value === currentValue)
  const busy = pick !== null || confirmation !== null

  const options = catalog.options
    .filter(o => o.value !== 'custom')
    .map((option) => {
      const icon = permissionGlyph(option.value)
      const reason = permissionUnavailableReason(option.value, availability)
      return { id: option.value, label: optionLabel(option, t), reason, ...icon === undefined ? {} : { icon } }
    })
  const items: MenuEntry[] = options.map(option => ({
    ...option,
    disabled: option.reason !== undefined,
    label: option.reason === undefined ? option.label : <span>{option.label}<small className={css.unavailable}>{t(`access.unavailable.${option.reason}`)}</small></span>,
  }))

  const submit = (id: string): void => {
    setPick(id)
    void command(`/permission ${id}`)
      .catch(() => false)
      .then(() => { setPick(null) })
  }

  const choose = (id: string): void => {
    setOpen(false)
    if (permissionUnavailableReason(id, availability) !== undefined) return
    if (id === value.currentValue) return
    if (id === FULL_ACCESS) {
      setAcknowledged(false)
      setConfirmation(id)
      return
    }
    submit(id)
  }

  const closeConfirmation = (): void => {
    setAcknowledged(false)
    setConfirmation(null)
  }

  const confirmFullAccess = (): void => {
    if (locked || !acknowledged || confirmation === null || permissionUnavailableReason(confirmation, availability) !== undefined) return
    const id = confirmation
    closeConfirmation()
    submit(id)
  }

  const currentUnavailable = permissionUnavailableReason(value.currentValue, availability)
  const modeLabel = current === undefined ? displayName(currentValue) : optionLabel(current, t)
  const currentLabel = currentUnavailable === undefined ? modeLabel : `${modeLabel} · ${t('access.unavailableLabel')}`
  const notice = currentUnavailable === undefined ? null : (
    <span className={css.unavailable} role="status">
      {t('access.currentUnavailable', { name: modeLabel })} {t(`access.unavailable.${currentUnavailable}`)}
    </span>
  )
  const confirmationDialog = (
    <RiskConfirmation
      open={confirmation !== null}
      title={t('access.confirm.title')}
      closeLabel={t('close')}
      description={t('access.confirm.description')}
      acknowledgeLabel={t('access.confirm.acknowledge')}
      cancelLabel={t('access.confirm.cancel')}
      confirmLabel={t('access.confirm.enable')}
      acknowledged={acknowledged}
      disabled={locked}
      onAcknowledgedChange={setAcknowledged}
      onCancel={closeConfirmation}
      onConfirm={confirmFullAccess}
    />
  )

  if (presentation === 'section') {
    return (
      <>
        <div className={css.sectionOptions} role="group" aria-label={t('input.accessMode', { name: currentLabel })}>
          {options.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === currentValue}
              className={clsx(css.sectionOption, item.id === currentValue && css.sectionOptionSelected)}
              disabled={locked || busy || item.reason !== undefined}
              onClick={() => { choose(item.id) }}
            >
              {item.icon !== undefined && <span className={css.sectionIcon}>{item.icon}</span>}
              <span className={css.sectionLabel}>{item.label}
                {item.reason !== undefined && <small className={css.unavailable}>{t(`access.unavailable.${item.reason}`)}</small>}
              </span>
              {item.id === currentValue && <span className={css.sectionCheck}>✓</span>}
            </button>
          ))}
        </div>
        {notice}
        {confirmationDialog}
      </>
    )
  }

  return (
    <>
      <Menu
        open={open}
        items={items}
        selectedId={currentValue}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        anchor={
          <button
            type="button"
            className={css.trigger}
            aria-label={t('input.accessMode', { name: currentLabel })}
            title={currentUnavailable === undefined ? current?.description
              : `${t('access.currentUnavailable', { name: modeLabel })} ${t(`access.unavailable.${currentUnavailable}`)}`}
            disabled={locked || busy}
            onClick={() => {
              if (phone && onOpenSettings !== undefined) {
                onOpenSettings('permission')
              } else {
                setOpen(!open)
              }
            }}
          >
            {permissionGlyph(currentValue) !== undefined && (
              <span className={css.triggerIcon} aria-hidden>{permissionGlyph(currentValue)}</span>
            )}
            <span className={css.triggerLabel}>{current === undefined ? displayName(currentValue) : optionLabel(current, t)}</span>
            {/* Same glyph + open rotation as the sibling ModelSelect trigger. */}
            <span className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden>
              <IconChevronDownOutline14 />
            </span>
          </button>
        }
      />
      {confirmationDialog}
    </>
  )
}
