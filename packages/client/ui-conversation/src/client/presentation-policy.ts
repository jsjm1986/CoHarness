/**
 * Runtime vocabulary derived from the persisted work-details mode. Renderers
 * and seats select single fields of this policy; none of them compares the
 * mode enum, so adding a mode changes only the table below.
 */

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { CollapseTiming, TranscriptViewMode } from '../submission-settings.ts'

/** Presentation capabilities that one work-details mode enables. */
export interface ChatPresentationPolicy {
  /** Mode this policy was derived from; for diagnostics, never for branching in renderers. */
  readonly mode: TranscriptViewMode
  /** Saved collapse timing; completion retains the default immediate folding. */
  readonly collapseTiming: CollapseTiming
  /** Whether a normally completed Turn folds its process rows behind the whole-Turn control. */
  readonly foldCompletedTurns: boolean
  /** Collapsible group headers for all Turns, historical Turns only, or no Turns. */
  readonly stepGrouping: 'collapsed' | 'history' | 'none'
  /** Show the running command, path, query, or reasoning detail in group titles. */
  readonly liveProcessDetail: boolean
  /** Whether a settled reasoning row previews its first line beside the Think title. */
  readonly settledReasoningPreview: boolean
}

const POLICIES: Readonly<Record<TranscriptViewMode, Omit<ChatPresentationPolicy, 'collapseTiming'>>> = {
  compact: {
    mode: 'compact',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: false,
    settledReasoningPreview: false,
  },
  standard: {
    mode: 'standard',
    foldCompletedTurns: true,
    stepGrouping: 'collapsed',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  detailed: {
    mode: 'detailed',
    foldCompletedTurns: true,
    stepGrouping: 'history',
    liveProcessDetail: true,
    settledReasoningPreview: true,
  },
  verbose: {
    mode: 'verbose',
    foldCompletedTurns: false,
    stepGrouping: 'none',
    liveProcessDetail: false,
    settledReasoningPreview: true,
  },
}

const COMBINED_POLICIES = new Map<string, ChatPresentationPolicy>()

/**
 * Resolve the policy constant for one mode and collapse timing. The same pair
 * always yields the same object, so selectors over a policy see stable identities.
 * @param mode - persisted work-details mode.
 * @param collapseTiming - when completed work details fold.
 * @returns the pair's presentation policy.
 */
export function presentationPolicyFor(
  mode: TranscriptViewMode,
  collapseTiming: CollapseTiming = 'completion',
): ChatPresentationPolicy {
  const key = `${mode}:${collapseTiming}`
  let policy = COMBINED_POLICIES.get(key)
  if (policy === undefined) {
    policy = { ...POLICIES[mode], collapseTiming }
    COMBINED_POLICIES.set(key, policy)
  }
  return policy
}

/**
 * Derive a policy observable from the mode and timing observables. The merged
 * snapshot keeps one stable identity until either input changes.
 * @param mode - live work-details mode.
 * @param collapseTiming - live collapse timing.
 * @returns observable policy that changes exactly when an input changes.
 */
export function derivePresentationPolicy(
  mode: ObservableSnapshot<TranscriptViewMode>,
  collapseTiming: ObservableSnapshot<CollapseTiming>,
): ObservableSnapshot<ChatPresentationPolicy> {
  return {
    getSnapshot: () => presentationPolicyFor(mode.getSnapshot(), collapseTiming.getSnapshot()),
    subscribe: (listener) => {
      const releaseMode = mode.subscribe(listener)
      const releaseTiming = collapseTiming.subscribe(listener)
      return () => { releaseMode(); releaseTiming() }
    },
  }
}
