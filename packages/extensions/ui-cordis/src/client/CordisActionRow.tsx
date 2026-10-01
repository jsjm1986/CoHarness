/** Localized cards for `cordis_stop` and `cordis_undefine`. */

import {
  IconInspectOutline12, IconStopFill16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { cordisActionCard } from './card-model.ts'
import { CordisPreparingRow } from './CordisPreparingRow.tsx'
import css from './CordisRunRow.module.css'

/** Full action-card props composed by the keyed Tool slot. */
export type CordisActionRowProps = ToolCallViewProps & PropsLocale<'@deepseek-ai/cordis'>

/** Render one Stop or Remove call with Cordis-owned localized copy. */
export function CordisActionRow(props: CordisActionRowProps) {
  if (props.phase === 'preparing') {
    const remove = props.toolName === 'cordis_undefine'
    return <CordisPreparingRow {...props}
      icon={remove ? <IconTrashOutline16 size={14} /> : <IconStopFill16 size={14} />}
      title={props.t(remove ? 'row.removeTitle' : 'row.stopTitle')}
      className={css.card} rowClassName={css.row} titleClassName={css.title} />
  }
  return <StartedCordisActionRow {...props} />
}

function StartedCordisActionRow({ callId, toolName, block, inspect, t }: Exclude<CordisActionRowProps, { phase: 'preparing' }>) {
  const card = cordisActionCard(block)
  const remove = toolName === 'cordis_undefine'
  const summary = card.errorSummary ?? card.pluginId ?? callId

  return (
    <div className={css.card} data-tool={toolName} data-state={card.state}>
      <div className={css.row}>
        <span className={css.icon}>
          {remove ? <IconTrashOutline16 size={14} /> : <IconStopFill16 size={14} />}
        </span>
        <span className={css.title}>{t(remove ? 'row.removeTitle' : 'row.stopTitle')}</span>
        <span className={css.separator} aria-hidden />
        <span className={card.errorSummary === null ? css.summary : css.error}>{summary}</span>
        {inspect !== undefined && (
          <button type="button" className={css.inspect} aria-label={t('row.inspect')} onClick={inspect}>
            <IconInspectOutline12 />
          </button>
        )}
      </div>
      {card.output !== null && <pre className={css.output}>{card.output}</pre>}
    </div>
  )
}
