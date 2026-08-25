/** Shared modal chrome for every step registered by this onboarding plugin. */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { holdInert, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './OnboardingModal.module.css'

const ignoreImplicitDismiss = (): void => {}

/**
 * Render a blocking onboarding dialog and keep the application root inert.
 * @param props.title - accessible and visible dialog title.
 * @param props.children - step-owned body and actions.
 * @returns the body-portaled modal.
 */
export function OnboardingModal({
  title, children,
}: {
  title: string
  children: ReactNode
}): ReactNode {
  useEffect(() => {
    const appRoot = document.getElementById('root')
    if (appRoot === null) return
    return holdInert(appRoot)
  }, [])

  return (
    <Modal
      open
      title={title}
      onClose={ignoreImplicitDismiss}
      headless
      className={css.dialog as string}
    >
      <div className={css.content}>
        <h2 className={css.title}>{title}</h2>
        <div className={css.body}>{children}</div>
      </div>
    </Modal>
  )
}
