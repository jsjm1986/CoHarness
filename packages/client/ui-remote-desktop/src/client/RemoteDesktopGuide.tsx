/** Remote-desktop target menu owned by the provider's guide entry. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RemoteDesktopGrantView } from '@deepseek-ai/dsh-api-remote-desktop-controller/types'
import type {} from './locales.ts'
import type { RemoteDesktopGuideInjected } from './face.ts'
import { RemoteDesktopGuideIcon } from './RemoteDesktopIcon.tsx'
import css from './RemoteDesktopGuide.module.css'

/** The guide entry receives framework props plus the injected grant listing. */
export type RemoteDesktopGuideProps =
  PropsRuntime<'sidebar.right.tab.guide.entry'> & PropsLocale<'remoteDesktop'> & InjectFace<RemoteDesktopGuideInjected>

/** Grant rows collapse to one card per target; the strongest level wins. */
function targetsOf(grants: readonly RemoteDesktopGrantView[]): { target: RemoteDesktopGrantView['target']; level: 'view' | 'control'; recording: boolean }[] {
  const byKey = new Map<string, { target: RemoteDesktopGrantView['target']; level: 'view' | 'control'; recording: boolean }>()
  for (const grant of grants) {
    if (grant.revokedAt !== undefined) continue
    const key = `${grant.target.nodeId} ${grant.target.desktop ?? ''}`
    const existing = byKey.get(key)
    if (existing === undefined) byKey.set(key, { target: grant.target, level: grant.level, recording: grant.recording })
    else byKey.set(key, {
      target: existing.target,
      level: existing.level === 'control' || grant.level === 'control' ? 'control' : 'view',
      recording: existing.recording || grant.recording,
    })
  }
  return [...byKey.values()]
}

type ListState = { phase: 'loading' } | { phase: 'ready'; targets: ReturnType<typeof targetsOf> } | { phase: 'failed' }

type MenuState = { open: boolean; attempt: number; list: ListState }

/**
 * Offer the targets the signed-in user is authorized for through the entry's
 * chevron menu; choosing one opens its remote-desktop tab where status and
 * consent resolve. Administrators configure endpoints and grants — users
 * never enter configuration here.
 * @param props - guide copy, enclosing tab actions, injected target listing.
 * @returns the authorized target picker.
 */
export function RemoteDesktopGuide({ title, description, kind, useTabInfo, t, listTargets }: RemoteDesktopGuideProps): ReactNode {
  const { tab } = useTabInfo()
  const [menu, setMenu] = useState<MenuState>({ open: false, attempt: 0, list: { phase: 'loading' } })
  const toggle = (): void => { setMenu(value => ({ ...value, open: !value.open, list: { phase: 'loading' } })) }
  const retry = (): void => { setMenu(value => ({ ...value, attempt: value.attempt + 1, list: { phase: 'loading' } })) }
  useEffect(() => {
    if (!menu.open) return
    const lifetime = new AbortController()
    const settle = (list: ListState): void => { if (!lifetime.signal.aborted) setMenu(value => ({ ...value, list })) }
    listTargets(lifetime.signal).then(
      (rows) => { settle({ phase: 'ready', targets: targetsOf(rows) }) },
      () => { settle({ phase: 'failed' }) },
    )
    return () => { lifetime.abort() }
  }, [menu.open, menu.attempt, listTargets])
  const { list } = menu
  const items = list.phase === 'loading'
    ? [{ id: 'loading', label: t('targetsLoading'), disabled: true }]
    : list.phase === 'failed'
      ? [{ id: 'error', label: t('targetsFailed'), disabled: true }, { id: 'retry', label: t('retry') }]
      : list.targets.length === 0
        ? [{ id: 'empty', label: t('targetsEmpty'), disabled: true }]
        : list.targets.map(({ target, level, recording }, index) => ({
          id: String(index),
          label: `${target.desktop === undefined ? target.nodeId : `${target.nodeId} · ${target.desktop}`} · ${t(level === 'control' ? 'control' : 'viewOnly')}${recording ? ` · ${t('recording')}` : ''}`,
        }))
  return <div className={css.entry} data-sidebar-right-guide-entry={kind}>
    <Button variant="ghost" className={css.main} aria-haspopup="menu" aria-expanded={menu.open} onClick={toggle}>
      <RemoteDesktopGuideIcon size={description === undefined ? 22 : 26} className={css.icon} />
      <span className={css.text}>
        <span className={css.title}>{title}</span>
        {description !== undefined && <span className={css.description}>{description}</span>}
      </span>
    </Button>
    <Menu
      open={menu.open} portal autoFocus align="end" className={css.menu}
      items={items}
      onClose={() => { setMenu(value => ({ ...value, open: false })) }}
      onSelect={(id) => {
        if (id === 'retry') { retry(); return }
        const chosen = list.phase === 'ready' ? list.targets[Number(id)] : undefined
        if (chosen === undefined) return
        setMenu(value => ({ ...value, open: false }))
        tab.actions.openTab('remoteDesktop', {
          replaceTab: true,
          params: { nodeId: chosen.target.nodeId, ...(chosen.target.desktop === undefined ? {} : { desktop: chosen.target.desktop }) },
        })
      }}
      anchor={<Button variant="ghost" className={css.trigger} aria-label={t('connectDescription')} aria-haspopup="menu" aria-expanded={menu.open}
        onClick={toggle}>
        <IconChevronDownOutline14 />
      </Button>}
    />
  </div>
}
