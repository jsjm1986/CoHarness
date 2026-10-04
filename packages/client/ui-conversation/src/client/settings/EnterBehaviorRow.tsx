/** General Settings row for the Composer's busy-state Enter preference. */
import type { SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BusyEnterBehavior } from '../contract/composer-submission.ts'
import type { ConversationKey } from '../locales.ts'
import { SettingsSelectRow } from './SettingsSelectRow.tsx'

/** Registration-side preference face. */
export interface EnterBehaviorRowInjected {
  hooks: {
    /** Persisted busy-state preference bound as useBusyEnter. */
    busyEnter: SnapshotStore<BusyEnterBehavior>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the busy-state plain-Enter behavior. */
  setBusyEnter: (behavior: BusyEnterBehavior) => void
}

/** Full Settings-row props. */
export type EnterBehaviorRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<EnterBehaviorRowInjected>

const OPTIONS: readonly {
  id: BusyEnterBehavior
  label: ConversationKey
}[] = [
  { id: 'queue', label: 'settings.enter.queue' },
  { id: 'steer', label: 'settings.enter.steer' },
]

/**
 * Render the busy-state Enter behavior selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function EnterBehaviorRow({ useBusyEnter, useSettings, setBusyEnter, t }: EnterBehaviorRowProps) {
  const behavior = useBusyEnter(value => value)
  const settings = useSettings(value => value)
  return (
    <SettingsSelectRow
      prefix="settings.enter"
      settings={settings}
      options={OPTIONS}
      selectedId={behavior}
      onSelect={(id) => { setBusyEnter(id as BusyEnterBehavior) }}
      t={t}
    />
  )
}
