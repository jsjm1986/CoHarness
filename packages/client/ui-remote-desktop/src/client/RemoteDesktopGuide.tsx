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

type MenuState = { phase: 'loading' } | { phase: 'ready'; targets: ReturnType<typeof targetsOf> } | { phase: 'failed' }

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
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<MenuState>({ phase: 'loading' })
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    listTargets(controller.signal).then(
      (rows) => { if (!controller.signal.aborted) setState({ phase: 'ready', targets: targetsOf(rows) }) },
      () => { if (!controller.signal.aborted) setState({ phase: 'failed' }) },
    )
    return () => { controller.abort() }
  }, [open, attempt, listTargets])
  const items = state.phase === 'loading'
    ? [{ id: 'loading', label: t('targetsLoading'), disabled: true }]
    : state.phase === 'failed'
      ? [{ id: 'error', label: t('targetsFailed'), disabled: true }, { id: 'retry', label: t('retry') }]
      : state.targets.length === 0
        ? [{ id: 'empty', label: t('targetsEmpty'), disabled: true }]
        : state.targets.map(({ target, level, recording }, index) => ({
          id: String(index),
          label: `${target.desktop === undefined ? target.nodeId : `${target.nodeId} · ${target.desktop}`} · ${t(level === 'control' ? 'control' : 'viewOnly')}${recording ? ` · ${t('recording')}` : ''}`,
        }))
  return <div className={css.entry} data-sidebar-right-guide-entry={kind}>
    <Button variant="ghost" className={css.main} aria-haspopup="menu" aria-expanded={open} onClick={() => { setState({ phase: 'loading' }); setOpen(value => !value) }}>
      <RemoteDesktopGuideIcon size={description === undefined ? 22 : 26} className={css.icon} />
      <span className={css.text}>
        <span className={css.title}>{title}</span>
        {description !== undefined && <span className={css.description}>{description}</span>}
      </span>
    </Button>
    <Menu
      open={open} portal autoFocus align="end" className={css.menu}
      items={items}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (id === 'retry') { setState({ phase: 'loading' }); setAttempt(value => value + 1); return }
        const chosen = state.phase === 'ready' ? state.targets[Number(id)] : undefined
        if (chosen === undefined) return
        setOpen(false)
        tab.actions.openTab('remoteDesktop', {
          replaceTab: true,
          params: { nodeId: chosen.target.nodeId, ...(chosen.target.desktop === undefined ? {} : { desktop: chosen.target.desktop }) },
        })
      }}
      anchor={<Button variant="ghost" className={css.trigger} aria-label={t('connectDescription')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setState({ phase: 'loading' }); setOpen(value => !value) }}>
        <IconChevronDownOutline14 />
      </Button>}
    />
  </div>
}
