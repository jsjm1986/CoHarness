/** Read-only Markdown viewer for logged plans and temporary review documents. */
import { useEffect, useMemo } from 'react'
import { FileTypeIcon, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { PlanRead } from './plan-resource.ts'
import { isReviewPreviewAddress } from './review-preview.ts'
import { planFailureLine } from './failure-line.ts'
import css from './PlanPreview.module.css'

/** Plan-read states and the read requester one Sidebar session injects. */
export interface PlanPreviewInjected {
  hooks: {
    /** Read states keyed by plan resource address. */
    planDocument: ObservableSnapshot<Record<string, PlanRead | undefined>>
  }
  /**
   * Request the logged plan behind one address; resolves after the read settles.
   * @param address - the tab's plan resource address.
   * @returns after the published state stands.
   */
  loadPlan: (address: string) => Promise<void>
}

type PlanPreviewProps = PropsRuntime<'sidebar.right.pane.tab'> & InjectFace<PlanPreviewInjected> & PropsLocale<'plan'>

/**
 * Render the submitted plan with its complete Markdown.
 * @param props - Framework-bound tab identity, plan reader, and copy.
 * @returns the plan document or a localized loading/failure state.
 */
export function PlanPreview({ useTabInfo, usePlanDocument, loadPlan, t }: PlanPreviewProps) {
  const { tab } = useTabInfo()
  const address = tab.navigation.address
  const temporary = isReviewPreviewAddress(address)
  const params = tab.navigation.params
  const read = usePlanDocument(map => (temporary ? undefined : map[address]))
  useEffect(() => {
    if (!temporary && tab.visible && read === undefined) void loadPlan(address)
  }, [temporary, tab.visible, read, address, loadPlan])
  const plan = temporary
    ? (params !== undefined && 'planReview' in params ? params.planReview : undefined)
    : read?.status === 'ready' ? read.plan : undefined
  const labels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  if (plan === undefined) return (
    <div className={css.message} role="status">
      {temporary ? t('preview.expired')
        : read === undefined || read.status === 'loading' ? t('preview.loading')
          : <>{t('preview.failed')}{read.status === 'failed' && <p>{planFailureLine(t, read.failure)}</p>}</>}
    </div>
  )
  return (
    <section className={css.preview} data-plan-preview={'callId' in plan ? plan.callId : address} aria-label={plan.title}>
      <div className={css.document}><MarkdownText text={plan.markdown} labels={labels} /></div>
    </section>
  )
}

/**
 * Display a plain file icon and the recovered plan heading in its tab.
 * @param props - Framework-bound tab identity and plan reader.
 * @returns a decorative file icon followed by the recovered title or the registry's label.
 */
export function PlanTitle({ useTabInfo, usePlanDocument, loadPlan }:
  PropsRuntime<'sidebar.right.pane.tab.title'> & InjectFace<PlanPreviewInjected>) {
  const { tab } = useTabInfo()
  const address = tab.navigation.address
  const temporary = isReviewPreviewAddress(address)
  const params = tab.navigation.params
  const read = usePlanDocument(map => (temporary ? undefined : map[address]))
  useEffect(() => {
    if (!temporary && tab.visible && read === undefined) void loadPlan(address)
  }, [temporary, tab.visible, read, address, loadPlan])
  const plan = temporary
    ? (params !== undefined && 'planReview' in params ? params.planReview : undefined)
    : read?.status === 'ready' ? read.plan : undefined
  return <><FileTypeIcon kind="other" size={16} className={css.titleIcon} />{plan?.title ?? tab.title}</>
}
