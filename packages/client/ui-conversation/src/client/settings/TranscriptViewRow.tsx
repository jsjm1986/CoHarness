/** General Settings row for work-details presentation. */
import type { SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  TRANSCRIPT_VIEW_MODES, type TranscriptViewMode,
} from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import { SettingsSelectRow } from './SettingsSelectRow.tsx'

/** Registration-side preference face. */
export interface TranscriptViewRowInjected {
  hooks: {
    /** Persisted work-details preference bound as useTranscriptView. */
    transcriptView: SnapshotStore<TranscriptViewMode>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the work-details presentation. */
  setTranscriptView: (mode: TranscriptViewMode) => void
}

/** Full Settings-row props. */
export type TranscriptViewRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<TranscriptViewRowInjected>

const OPTION_LABELS: Record<TranscriptViewMode, ConversationKey> = {
  compact: 'settings.transcript.compact',
  standard: 'settings.transcript.standard',
  detailed: 'settings.transcript.detailed',
  verbose: 'settings.transcript.verbose',
}

const OPTIONS: readonly {
  id: TranscriptViewMode
  label: ConversationKey
}[] = TRANSCRIPT_VIEW_MODES.map(id => ({
  id,
  label: OPTION_LABELS[id],
}))

/**
 * Render the work-details mode selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function TranscriptViewRow({ useTranscriptView, useSettings, setTranscriptView, t }: TranscriptViewRowProps) {
  const mode = useTranscriptView(value => value)
  const settings = useSettings(value => value)
  return (
    <SettingsSelectRow
      prefix="settings.transcript"
      settings={settings}
      options={OPTIONS}
      selectedId={mode}
      onSelect={(id) => { setTranscriptView(id as TranscriptViewMode) }}
      t={t}
    />
  )
}
