/** Remote-desktop launch form owned by the provider's guide entry. */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './locales.ts'
import { RemoteDesktopGuideIcon } from './RemoteDesktopIcon.tsx'
import css from './RemoteDesktopGuide.module.css'

/** The guide entry receives only framework props; navigation goes through the tab's actions. */
export type RemoteDesktopGuideProps = PropsRuntime<'sidebar.right.tab.guide.entry'> & PropsLocale<'remoteDesktop'>

/**
 * Ask for a target node and open its remote-desktop tab; endpoint availability
 * and authorization resolve on the tab's own status surface.
 * @param props - guide copy, enclosing tab actions, and localized copy.
 * @returns the launch card for a configured desktop target.
 */
export function RemoteDesktopGuide({ title, description, kind, useTabInfo, t }: RemoteDesktopGuideProps): ReactNode {
  const { tab } = useTabInfo()
  const [nodeId, setNodeId] = useState('')
  const [desktop, setDesktop] = useState('')
  const open = () => {
    const node = nodeId.trim()
    if (node === '') return
    const display = desktop.trim()
    tab.actions.openTab('remoteDesktop', {
      replaceTab: true,
      params: { nodeId: node, ...(display === '' ? {} : { desktop: display }) },
    })
  }
  return <div className={css.entry} data-sidebar-right-guide-entry={kind}>
    <div className={css.head}>
      <RemoteDesktopGuideIcon size={description === undefined ? 22 : 26} className={css.icon} />
      <span className={css.text}>
        <span className={css.title}>{title}</span>
        {description !== undefined && <span className={css.description}>{description}</span>}
      </span>
    </div>
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); open() }}>
      <input className={css.field} required value={nodeId} placeholder={t('nodeId')} aria-label={t('nodeId')}
        onChange={event => setNodeId(event.currentTarget.value)} />
      <input className={css.field} value={desktop} placeholder={t('desktop')} aria-label={t('desktop')}
        onChange={event => setDesktop(event.currentTarget.value)} />
      <Button type="submit" className={css.action} disabled={nodeId.trim() === ''}>{t('connect')}</Button>
    </form>
  </div>
}
