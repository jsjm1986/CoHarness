/** Current skill source, read without invoking the skill or resolving its relative links. */
import { useEffect, useState } from 'react'
import type { SkillPreview as SkillSource } from '@deepseek-ai/dsh-api-remotes/client'
import { CodeBlock, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Session-scoped source lookup; cancellation belongs to the open preview. */
export interface SkillPreviewInjected {
  /** Reject on lookup failure; return undefined when the skill is unavailable to the user. */
  loadSkill: (name: string, signal: AbortSignal) => Promise<SkillSource | undefined>
}

type SkillPreviewProps = PropsRuntime<'conversation.chat.skill-preview'> & PropsLocale<'skill'> & SkillPreviewInjected
type PreviewResult = {
  readonly sessionId: SkillPreviewProps['sessionId']
  readonly skillName: string
} & ({ readonly kind: 'ready'; readonly skill: SkillSource | undefined } | { readonly kind: 'failed' })

/**
 * Read current instructions while keeping late results out of a replaced preview.
 * @param props - session, selected skill, source reader, dismissal, and locale.
 * @returns a source dialog with loading, missing, and failure states.
 */
export function SkillPreview({ sessionId, skillName, loadSkill, onClose, t }: SkillPreviewProps) {
  const [result, setResult] = useState<PreviewResult>()
  useEffect(() => {
    const abort = new AbortController()
    setResult(undefined)
    void loadSkill(skillName, abort.signal).then(
      (skill) => {
        if (!abort.signal.aborted) setResult({ sessionId, skillName, kind: 'ready', skill })
      },
      () => {
        if (!abort.signal.aborted) setResult({ sessionId, skillName, kind: 'failed' })
      },
    )
    return () => { abort.abort() }
  }, [sessionId, skillName, loadSkill])
  const current = result?.sessionId === sessionId && result.skillName === skillName ? result : undefined
  const skill = current?.kind === 'ready' ? current.skill : undefined
  return (
    <Modal
      open
      title={`/${skillName}`}
      onClose={onClose}
      closeLabel={t('close')}
      {...skill === undefined ? {} : { description: skill.description }}
    >
      {current === undefined
        ? <p role="status">{t('preview.loading')}</p>
        : current.kind === 'failed'
          ? <p role="alert">{t('preview.failed')}</p>
          : skill === undefined
            ? <p>{t('preview.missing')}</p>
            : <CodeBlock code={skill.contentMarkdown} lang="markdown" copyLabel={t('copy')} copiedLabel={t('copied')} />}
    </Modal>
  )
}
