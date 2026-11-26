/** Load the Plugins page body when its main slot is first selected. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SlotComponent } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerPage, PluginManagerPageProps } from './PluginManagerPage.tsx'
import css from './DeferredPluginManagerPage.module.css'

type View =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; Body: typeof PluginManagerPage }

/**
 * Own one resolved page component for a Plugins slot registration.
 * @returns the callable main-slot component, with a retry state for chunk failures.
 */
export function createDeferredPluginManagerPage(): SlotComponent<PluginManagerPageProps> {
  let loaded: typeof PluginManagerPage | undefined
  return function DeferredPluginManagerPage(props) {
    const { ensure, t } = props
    const [view, setView] = useState<View>(() => loaded === undefined
      ? { kind: 'loading' }
      : { kind: 'ready', Body: loaded })
    useEffect(() => { ensure() }, [ensure])
    useEffect(() => {
      if (view.kind !== 'loading') return
      let active = true
      void import('./PluginManagerPage.tsx').then(({ PluginManagerPage: Body }) => {
        loaded = Body
        if (active) setView({ kind: 'ready', Body })
      }, () => {
        if (active) setView({ kind: 'failed' })
      })
      return () => { active = false }
    }, [view.kind])

    if (view.kind === 'ready') return <view.Body {...props} />
    return (
      <div className={css.state}>
        {view.kind === 'failed' ? (
          <>
            <p role="alert">{t('pageUnavailable')}</p>
            <Button variant="outline" onClick={() => { setView({ kind: 'loading' }) }}>{t('retry')}</Button>
          </>
        ) : <p role="status">{t('loading')}</p>}
      </div>
    )
  }
}
