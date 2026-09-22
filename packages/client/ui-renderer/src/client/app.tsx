/**
 * Real-UI assembly closure. The whole layout tree hangs from the built-in
 * `root` slot, which is the only ctx-level slot render in the application.
 */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { bindSnapshotSelector } from './bind.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale plugin's Context merge (ctx.get('locale')).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'

/** Inert source keeping the title's locale subscription a standing hook when no locale service is installed. */
const DETACHED_LOCALE: HostObservable<undefined> = {
  getSnapshot: () => undefined,
  subscribe: () => () => {},
}

/** Inputs available after the UI renderer's inject set activates. */
export interface AssemblyDeps {
  /** Client context carrying the slots and sessions services. */
  ctx: Context
}

/**
 * Build the assembled application factory.
 * @param deps - Active UI-renderer dependencies.
 * @returns Factory producing the application React tree.
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('ui renderer: sessions service unavailable')
  const useSessions = bindSnapshotSelector(sessions.list)
  // The locale service is optional to the assembly (test compositions may omit
  // it); when present the product title falls back to the localized brand name
  // and revision ticks re-render the projection.
  const locale = ctx.get('locale')
  const useLocaleSnapshot = bindSnapshotSelector<LocaleSnapshot | undefined>(locale ?? DETACHED_LOCALE)
  const brandT = locale?.bind('common')
  const SessionDocumentTitle = (): ReactNode => {
    const title = useSessions((state) => {
      const id = state.current
      return id === undefined ? undefined : state.byId[id]?.title
    })
    useLocaleSnapshot(snapshot => snapshot?.revision)
    const productTitle = process.env.DSH_CLIENT_TITLE ?? brandT?.('brand.product')
    return <DocumentTitle title={title} productTitle={productTitle} />
  }
  return () => (
    <>
      <SessionDocumentTitle />
      {ctx.slots.renderSlot('root', {})}
    </>
  )
}
