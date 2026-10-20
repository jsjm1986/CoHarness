/** Remote-desktop target list owned by the provider's guide entry. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
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

/**
 * List the targets the signed-in user is authorized for; clicking one opens
 * its remote-desktop tab where status and consent resolve. Administrators
 * configure endpoints and grants — users never enter configuration here.
 * @param props - guide copy, enclosing tab actions, injected target listing.
 * @returns the authorized target picker.
 */
export function RemoteDesktopGuide({ title, description, kind, useTabInfo, t, listTargets }: RemoteDesktopGuideProps): ReactNode {
  const { tab } = useTabInfo()
  const [grants, setGrants] = useState<RemoteDesktopGrantView[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    setFailed(false)
    listTargets(controller.signal)
      .then((rows) => { if (!controller.signal.aborted) setGrants(rows) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [listTargets])
  const targets = grants === null ? [] : targetsOf(grants)
  return <div className={css.entry} data-sidebar-right-guide-entry={kind}>
    <div className={css.head}>
      <RemoteDesktopGuideIcon size={description === undefined ? 22 : 26} className={css.icon} />
      <span className={css.text}>
        <span className={css.title}>{title}</span>
        {description !== undefined && <span className={css.description}>{description}</span>}
      </span>
    </div>
    {failed && <p className={css.empty}>{t('targetsFailed')}</p>}
    {!failed && grants === null && <p className={css.empty}>{t('targetsLoading')}</p>}
    {!failed && grants !== null && targets.length === 0 && <p className={css.empty}>{t('targetsEmpty')}</p>}
    <div className={css.targets}>
      {targets.map(({ target, level, recording }) => {
        const label = target.desktop === undefined ? target.nodeId : `${target.nodeId} · ${target.desktop}`
        return <Button
          key={`${target.nodeId} ${target.desktop ?? ''}`}
          className={css.target}
          onClick={() => tab.actions.openTab('remoteDesktop', {
            replaceTab: true,
            params: { nodeId: target.nodeId, ...(target.desktop === undefined ? {} : { desktop: target.desktop }) },
          })}
        >
          <span className={css.targetName}>{label}</span>
          <span className={css.targetMeta}>
            {t(level === 'control' ? 'control' : 'viewOnly')}{recording ? ` · ${t('recording')}` : ''}
          </span>
        </Button>
      })}
    </div>
  </div>
}
