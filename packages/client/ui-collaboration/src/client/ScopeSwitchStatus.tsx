import { useEffect, useRef, useState } from 'react'
import { IconLoadingOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CollaborationScopeTarget } from './collaboration-client.ts'
import type { CollaborationKey } from './locales.ts'
import css from './ScopeSwitchStatus.module.css'

/** Localized copy function used by the scope-switch status layer. */
type Translate = (key: CollaborationKey, params?: Record<string, string | number>) => string

/** Stage thresholds are UX milestones for the asynchronous runtime hand-off. */
const START_SERVICE_AFTER_MS = 1_000
const CONNECT_WORKBENCH_AFTER_MS = 3_000
const LONG_WAIT_AFTER_MS = 6_000

function stage(elapsedMs: number): CollaborationKey {
  if (elapsedMs >= LONG_WAIT_AFTER_MS) return 'scope.progress.long'
  if (elapsedMs >= CONNECT_WORKBENCH_AFTER_MS) return 'scope.progress.connect'
  if (elapsedMs >= START_SERVICE_AFTER_MS) return 'scope.progress.start'
  return 'scope.progress.prepare'
}

/**
 * Show a non-dismissible status layer while the Gateway prepares a scope.
 * @param props - target scope and localized copy function.
 * @returns the status dialog.
 */
export function ScopeSwitchStatus({ target, t }: { target: CollaborationScopeTarget; t: Translate }) {
  const targetKey = target.kind === 'personal'
    ? 'personal'
    : `project:${target.projectId}`
  const startedAt = useRef(Date.now())
  const [now, setNow] = useState(startedAt.current)

  useEffect(() => {
    const nextStartedAt = Date.now()
    startedAt.current = nextStartedAt
    setNow(nextStartedAt)
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { window.clearInterval(timer) }
  }, [targetKey])

  const elapsedMs = Math.max(0, now - startedAt.current)
  const elapsedSeconds = Math.floor(elapsedMs / 1_000)
  const stageText = t(stage(elapsedMs))
  const targetName = target.kind === 'personal'
    ? t('scope.personal')
    : target.projectName === '' ? t('scope.projectFallback') : target.projectName

  return (
    <Modal
      open
      onClose={() => { /* Scope changes cannot be cancelled after submission. */ }}
      title={t('scope.switching')}
      headless
      className={css.dialog ?? ''}
    >
      <div className={css.content} role="status" aria-live="polite" aria-busy="true">
        <div className={css.iconFrame} aria-hidden="true">
          <IconLoadingOutline16 className={css.spinner} size={22} />
        </div>
        <div className={css.copy}>
          <h2 className={css.title}>{t('scope.switching')}</h2>
          <p className={css.target}>{t('scope.switchingTarget', { name: targetName })}</p>
          <p className={css.stage}>{stageText}</p>
          <div
            className={css.progress}
            role="progressbar"
            aria-label={t('scope.progress.aria')}
            aria-valuetext={stageText}
          >
            <span className={css.progressIndicator} />
          </div>
          <p className={css.waited} aria-hidden="true">{t('scope.waited', { seconds: elapsedSeconds })}</p>
        </div>
      </div>
    </Modal>
  )
}
