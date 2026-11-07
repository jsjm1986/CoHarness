/** Document-owned protection for unsaved Admin forms; draft values stay in their existing form owners. */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useBlocker } from 'react-router-dom'
import { Button, Dialog } from './components/ui.tsx'
import { adminLanguage, translateCopy } from './language.ts'

const zh = {
  title: '保留当前编辑',
  description: '当前页面有未结束的编辑或提交操作。请先保存或取消编辑；也可以在新标签页打开目标，当前页面和编辑内容会保留。',
  stay: '留在当前页面', open: '在新标签页打开',
}
const en: Record<keyof typeof zh, string> = {
  title: 'Keep your current edits',
  description: 'This page has editing or submission in progress. Save or cancel your edits first, or open the destination in a new tab to keep this page and its edits.',
  stay: 'Stay on this page', open: 'Open in a new tab',
}

interface PendingEdits {
  set(owner: symbol, dirty: boolean): void
  navigate(url: string): void
  canReplace(): boolean
}
const PendingEditsContext = createContext<PendingEdits | undefined>(undefined)

/** @param props - one Admin document and its forms; protectHistory requires a Data Router. @returns navigation protection without storing form values. */
export function PendingEditsProvider({ children, protectHistory = false }: { children: ReactNode; protectHistory?: boolean }) {
  const owners = useRef(new Set<symbol>())
  const hasChanges = useCallback(() => owners.current.size > 0, [])
  const [destination, setDestination] = useState<string | null | undefined>()
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  const protection = useMemo<PendingEdits>(() => ({
    set(owner, dirty) { if (dirty) owners.current.add(owner); else owners.current.delete(owner) },
    navigate(url) { if (owners.current.size > 0) setDestination(url); else window.location.assign(url) },
    canReplace() { if (owners.current.size === 0) return true; setDestination(null); return false },
  }), [])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => {
      if (owners.current.size === 0) return
      event.preventDefault()
      event.returnValue = ''
    }
    const followLink = (event: MouseEvent): void => {
      if (owners.current.size === 0 || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (anchor === null || anchor.target && anchor.target !== '_self' || anchor.hasAttribute('download')) return
      const url = new URL(anchor.href)
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) return
      event.preventDefault()
      event.stopPropagation()
      setDestination(url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : anchor.href)
    }
    window.addEventListener('beforeunload', beforeUnload)
    document.addEventListener('click', followLink, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', followLink, true) }
  }, [])
  return <PendingEditsContext.Provider value={protection}>
    {children}
    {protectHistory && <PendingHistory hasChanges={hasChanges} showDestination={setDestination} />}
    <Dialog open={destination !== undefined} title={t('title')} description={t('description')} onClose={() => setDestination(undefined)} footer={<>
      <Button onClick={() => setDestination(undefined)}>{t('stay')}</Button>
      {destination === null || destination === undefined ? null : <a className="button button-primary" href={destination} target="_blank" rel="noopener noreferrer" onClick={() => setDestination(undefined)}>{t('open')}</a>}
    </>} />
  </PendingEditsContext.Provider>
}

/** Router-owned back/forward navigation must settle before the current form can unmount. */
function PendingHistory({ hasChanges, showDestination }: { hasChanges(): boolean; showDestination(url: string): void }) {
  const blocker = useBlocker(({ historyAction, currentLocation, nextLocation }) => historyAction === 'POP' && hasChanges()
    && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search))
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    showDestination(`${blocker.location.pathname}${blocker.location.search}${blocker.location.hash}`)
    blocker.reset()
  }, [blocker, showDestination])
  return null
}

/** @param dirty - derived from the owning form's baseline, including unsettled writes. */
export function usePendingEdits(dirty: boolean): void {
  const protection = useContext(PendingEditsContext)
  const [owner] = useState(() => Symbol('admin-form'))
  useLayoutEffect(() => {
    protection?.set(owner, dirty)
    return () => { protection?.set(owner, false) }
  }, [protection, owner, dirty])
}

/** @returns document-local navigation protection; standalone page previews use their existing navigation. */
export function useProtectedNavigation(): Pick<PendingEdits, 'navigate' | 'canReplace'> {
  const protection = useContext(PendingEditsContext)
  return protection ?? { navigate: url => { window.location.assign(url) }, canReplace: () => true }
}
