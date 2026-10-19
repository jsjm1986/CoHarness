/** General Settings row for work-details collapse timing. */
import type { SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  COLLAPSE_TIMINGS, type CollapseTiming,
} from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import { SettingsSelectRow } from './SettingsSelectRow.tsx'

/** Registration-side preference face. */
export interface CollapseTimingRowInjected {
  hooks: {
    /** Persisted collapse-timing preference bound as useCollapseTiming. */
    collapseTiming: SnapshotStore<CollapseTiming>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the collapse timing. */
  setCollapseTiming: (timing: CollapseTiming) => void
}

/** Full Settings-row props. */
export type CollapseTimingRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<CollapseTimingRowInjected>

const OPTION_LABELS: Record<CollapseTiming, ConversationKey> = {
  completion: 'settings.collapseTiming.completion',
  'next-input': 'settings.collapseTiming.next-input',
}
const OPTIONS: readonly {
  id: CollapseTiming
  label: ConversationKey
}[] = COLLAPSE_TIMINGS.map(id => ({
  id,
  label: OPTION_LABELS[id],
}))

/**
 * Render the collapse-timing selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function CollapseTimingRow({ useCollapseTiming, useSettings, setCollapseTiming, t }: CollapseTimingRowProps) {
  const timing = useCollapseTiming(value => value)
  const settings = useSettings(value => value)
  return (
    <SettingsSelectRow
      prefix="settings.collapseTiming"
      settings={settings}
      options={OPTIONS}
      selectedId={timing}
      onSelect={(id) => { setCollapseTiming(id as CollapseTiming) }}
      t={t}
    />
  )
}
