/** A Session composer lifetime restores retained Host terminals without saving sidebar layout. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconWarningOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './locales.ts'
import css from './TerminalRecovery.module.css'

/** The plugin deduplicates concurrent recovery; the component only owns an error notice. */
export interface TerminalRecoveryInjected {
  readonly hooks: { readonly ownership: HostObservable<string | undefined> }
  /** @param signal - this composer's recovery publication lifetime. @returns after this recovery attempt settles. */
  readonly restore: (signal: AbortSignal) => Promise<void>
}

/**
 * Restore terminals when a Session is displayed, with a retry action on lookup failure.
 * @param props - Session composer lifetime, restoration callback and localized copy.
 * @returns nothing on success, or an unobtrusive retry control.
 */
export function TerminalRecovery({ restore, useOwnership, t }: PropsRuntime<'conversation.input.left'> & PropsLocale<'sidebarTerminal'> & InjectFace<TerminalRecoveryInjected>): ReactNode {
  const ownership = useOwnership(value => value)
  const [error, setError] = useState<{ ownership: string; message: string }>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setError(undefined)
    if (ownership === undefined) return
    const lifetime = new AbortController()
    void restore(lifetime.signal).then(() => { if (!lifetime.signal.aborted) setError(undefined) }, (reason: unknown) => {
      if (!lifetime.signal.aborted) setError({ ownership, message: reason instanceof Error ? reason.message : String(reason) })
    })
    return () => { lifetime.abort() }
  }, [restore, ownership, attempt])
  return error === undefined || ownership === undefined || error.ownership !== ownership ? null : (
    <Button
      size="sm"
      variant="ghost"
      icon={<IconWarningOutline16 />}
      className={css.retry}
      title={t('recoveryFailed', { message: error.message })}
      onClick={() => { setError(undefined); setAttempt(value => value + 1) }}
    >
      <span data-clip-label>{t('retryRecovery')}</span>
    </Button>
  )
}
