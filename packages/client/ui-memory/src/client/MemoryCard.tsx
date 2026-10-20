/** The Memory card on the Plugins page: the namespace's only switch. */
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the Plugins page's `plugins.item` contract.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { MemoryCardFace } from './memory-card-controller.ts'
import css from './MemoryCard.module.css'

/** Props the renderer binds for the Memory card. */
export type MemoryCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'memory'>
  & InjectFace<MemoryCardFace>

/**
 * Render the Memory card: its one-liner on the Plugins page's Configuration
 * group, or the enable toggle on its own detail page.
 * @param props - locale copy, the card snapshot, its write action, and the view the page asks for.
 * @returns the card's content for the asked view, or nothing when the namespace is unavailable.
 */
export function MemoryCard(props: MemoryCardProps) {
  const { t } = props
  const state = props.useMemoryCard(snapshot => snapshot)
  if (!state.available) return null
  if (props.view === 'summary') return t('card.description')
  return (
    <div className={css.cardRow}>
      <span className={css.cardText}>
        <span>{t('card.enabled')}</span>
        <span className={css.cardHint}>{t('card.enabledHint')}</span>
        {state.failed ? <span className={css.editorError}>{t('card.writeError')}</span> : null}
      </span>
      <Switch
        checked={state.enabled}
        disabled={!state.writable || state.saving}
        label={t('card.enabled')}
        onChange={(next) => { props.setEnabled(next) }}
      />
    </div>
  )
}
