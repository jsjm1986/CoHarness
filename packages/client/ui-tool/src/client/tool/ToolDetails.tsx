/** Card-aware output body for the selected Tool call in details. */
import { DiffBlock, ReadBlock, SearchBlock, TerminalBlock, WebBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolDetailsProps } from '../contract/slots.ts'
import { ToolDetails as DetailList } from './components/ToolDetails.tsx'
import { detailsCardModel } from './models/details-card-model.ts'
import { diffCardModel } from './models/diff-card-model.ts'
import { imageCardModel } from './models/image-card-model.ts'
import { readCardModel } from './models/read-card-model.ts'
import { searchCardModel } from './models/search-card-model.ts'
import { terminalBlockLabels, terminalCardModel } from './models/terminal-card-model.ts'
import { todoDiffModel } from './models/todo-diff-model.ts'
import { diffBlockLabels, readBlockLabels, searchBlockLabels, webBlockLabels } from './models/primitive-labels.ts'
import { resultText } from './models/tool-call-model.ts'
import { webCardModel } from './models/web-card-model.ts'
import css from './ToolDetails.module.css'

/**
 * Render the selected Tool call's structured output when its presentation
 * intent is known, otherwise preserve the flattened result text.
 * @param props - selected call slice, workspace root, host home, session seat, and locale seat.
 * @returns the details output body.
 */
export function ToolDetails({
  block, cwd, renderMessageImages, useHostDescription, useSession, t,
}: Pick<ToolDetailsProps, 'block' | 'cwd' | 'renderMessageImages' | 'useHostDescription' | 'useSession' | 't'>) {
  const home = useHostDescription(description => description?.home)
  const baseline = useSession(snapshot => snapshot.views.get('tool-todo-history')?.get(block.callId))
  const hasMore = useSession(snapshot => snapshot.hasMore)
  const terminal = terminalCardModel(block, cwd)
  if (terminal !== null) {
    return (
      <>
        {terminal.description !== undefined ? (
          <div className={css.description}>{terminal.description}</div>
        ) : null}
        <TerminalBlock {...terminal.card} labels={terminalBlockLabels(t)} className={css.cardBody} />
      </>
    )
  }
  const read = readCardModel(block, cwd, home)
  if (read !== null) return <ReadBlock {...read} labels={readBlockLabels(t)} className={css.read} />
  // The details owner supplies the same slot-backed renderer the chat row
  // receives; an image without it still shows its label and envelope text.
  const image = imageCardModel(block, cwd, home)
  if (image !== null) {
    return (
      <>
        <div className={css.imageLabel}>{image.label}</div>
        {renderMessageImages?.({ images: image.images, align: 'start' })}
        <pre className={css.code}>{image.text}</pre>
      </>
    )
  }
  const diff = diffCardModel(block)
  if (diff !== null) return <DiffBlock {...diff.card} labels={diffBlockLabels(t)} className={css.cardBody} />
  const search = searchCardModel(block)
  if (search !== null) {
    return (
      <>
        <SearchBlock {...search.card} labels={searchBlockLabels(t)} className={css.cardBody} />
        {search.recovery !== undefined ? <div className={css.recovery}>{search.recovery}</div> : null}
      </>
    )
  }
  const web = webCardModel(block)
  if (web !== null) {
    const body = 'kind' in block ? resultText(block) : ''
    return (
      <>
        <WebBlock {...web} labels={webBlockLabels(t)} className={css.web} />
        {body !== '' ? <pre className={css.code}>{body}</pre> : null}
      </>
    )
  }
  if (!('kind' in block)) return <div className={css.empty}>{t('details.running')}</div>
  // Recorded entity lists, receipts, and report fields share the compact
  // detail body the keyed chat rows render; todo_write adds its
  // recorded-list diff against the preceding durable write.
  const details = todoDiffModel(block, baseline, hasMore, t)?.details
    ?? detailsCardModel(block, t, document.documentElement.lang)
  if (details !== null) return <DetailList model={details} t={t} />
  return (
    <pre className={css.code} data-error={block.isError || undefined}>
      {resultText(block)}
    </pre>
  )
}
