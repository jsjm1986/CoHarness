/** Shared loading and recovery controls for deferred Admin content. */
import { lazy, useMemo, type ComponentType } from 'react'
import { adminLanguage, translateCopy } from '../language.ts'
import { en as chromeEn, zh as chromeZh } from '../chrome.copy.ts'
import { Button, ErrorBanner, PageHeader } from './ui.tsx'

type BackgroundScheduler = {
  postTask(run: () => void, options: { priority: 'background'; signal: AbortSignal }): Promise<void>
}

/**
 * Share an import between navigation and preparation after a ready view paints.
 * @param importModule - the dynamic import used by both callers.
 * @param preparationFrames - animation frames allowed for the ready view before queuing preparation.
 * @returns the shared import, its resolved module, and preparation with a queued-work disposer.
 */
export function createPageImport<Module>(importModule: () => Promise<Module>, preparationFrames: 1 | 2 = 2) {
  let request: Promise<Module> | undefined
  let loaded: Module | undefined
  const load = () => request ??= importModule()
    .then(module => {
      loaded = module
      return module
    })
    .catch((cause: unknown) => {
      request = undefined
      throw cause
    })
  const prepare = () => {
    if (request !== undefined) return
    const controller = new AbortController()
    let timer: number | undefined
    const preload = () => {
      if (controller.signal.aborted) return
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
      if (document.visibilityState !== 'visible' || !navigator.onLine || connection?.saveData) return
      void load().catch(() => {
        // The navigation boundary owns import errors when the destination is opened.
      })
    }
    const enqueue = () => {
      const scheduler = (window as Window & { scheduler?: BackgroundScheduler }).scheduler
      if (scheduler?.postTask !== undefined) {
        void scheduler.postTask(preload, { priority: 'background', signal: controller.signal }).catch(() => {
          // Disposing the source view cancels the queued task.
        })
      } else {
        timer = window.setTimeout(preload, 0)
      }
    }
    // The queued task runs after the frame callback returns to the browser.
    let frame = window.requestAnimationFrame(() => {
      if (preparationFrames === 1) enqueue()
      else frame = window.requestAnimationFrame(enqueue)
    })
    return () => {
      controller.abort()
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }
  return { load, prepare, get loaded() { return loaded } }
}

/**
 * Load an Admin page or view and keep the reload action within its loading boundary.
 * @param load - the dynamic component import.
 * @returns a deferred component with a localized load-error state.
 */
export function lazyPage<Props>(load: () => Promise<{ default: ComponentType<Props> }>) {
  return lazy<ComponentType<Props>>(() => load().catch((cause: unknown) => {
    console.error('Admin page import failed', cause)
    return { default: PageLoadFailure }
  }))
}

/** @returns the localized route-loading status. */
export function PageLoading() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return <p role="status">{t('loading')}</p>
}

/** @returns the localized import error and page reload action. */
export function PageLoadFailure() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh: chromeZh, en: chromeEn }), [])
  return <div className="page">
    <PageHeader title={t('pageUnavailable')} />
    <ErrorBanner message={t('pageLoadFailed')} />
    <Button onClick={() => window.location.reload()}>{t('reloadPage')}</Button>
  </div>
}
