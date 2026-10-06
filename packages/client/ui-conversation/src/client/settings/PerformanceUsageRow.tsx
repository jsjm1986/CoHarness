/** General Settings row for performance and usage detail. */
import type { SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  PERFORMANCE_USAGE_MODES, type PerformanceUsageMode,
} from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import { SettingsSelectRow } from './SettingsSelectRow.tsx'

/** Registration-side preference face. */
export interface PerformanceUsageRowInjected {
  hooks: {
    /** Persisted performance detail preference bound as usePerformanceUsage. */
    performanceUsage: SnapshotStore<PerformanceUsageMode>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the performance and usage detail. */
  setPerformanceUsage: (mode: PerformanceUsageMode) => void
}

/** Full Settings-row props. */
export type PerformanceUsageRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<PerformanceUsageRowInjected>

const OPTION_LABELS: Record<PerformanceUsageMode, ConversationKey> = {
  compact: 'settings.performance.compact',
  detailed: 'settings.performance.detailed',
}

const OPTIONS: readonly {
  id: PerformanceUsageMode
  label: ConversationKey
}[] = PERFORMANCE_USAGE_MODES.map(id => ({
  id,
  label: OPTION_LABELS[id],
}))

/**
 * Render the performance and usage detail selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function PerformanceUsageRow({ usePerformanceUsage, useSettings, setPerformanceUsage, t }: PerformanceUsageRowProps) {
  const mode = usePerformanceUsage(value => value)
  const settings = useSettings(value => value)
  return (
    <SettingsSelectRow
      prefix="settings.performance"
      settings={settings}
      options={OPTIONS}
      selectedId={mode}
      onSelect={(id) => { setPerformanceUsage(id as PerformanceUsageMode) }}
      t={t}
    />
  )
}
