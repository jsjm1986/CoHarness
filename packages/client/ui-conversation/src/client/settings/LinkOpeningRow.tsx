/** General Settings row for Chat HTTP(S) link destinations. */
import type { ObservableSnapshot, SettingsControlState, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LinkOpening } from '../../submission-settings.ts'
import type { ConversationKey } from '../locales.ts'
import { SettingsSelectRow } from './SettingsSelectRow.tsx'

/** Registration-side link-opening preference. */
export interface LinkOpeningRowInjected {
  hooks: {
    /** Current destination bound as useLinkOpening. */
    linkOpening: SnapshotStore<LinkOpening>
    /** Whether the built-in browser is registered, bound as useBrowserAvailable. */
    browserAvailable: ObservableSnapshot<boolean>
    /** Settings writability and write state bound as useSettings. */
    settings: SnapshotStore<SettingsControlState>
  }
  /** Change the default destination for Chat HTTP(S) links. */
  setLinkOpening: (destination: LinkOpening) => void
}

/** Full Settings-row props. */
export type LinkOpeningRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'conversation'>
  & InjectFace<LinkOpeningRowInjected>

const OPTIONS: readonly {
  id: LinkOpening
  label: ConversationKey
}[] = [
  { id: 'sidebar', label: 'settings.links.sidebar' },
  { id: 'new-tab', label: 'settings.links.newTab' },
]

/**
 * Render the link-opening destination selector; hidden when the assembly has
 * no built-in browser to point at.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function LinkOpeningRow({ useLinkOpening, useBrowserAvailable, useSettings, setLinkOpening, t }: LinkOpeningRowProps) {
  const destination = useLinkOpening(value => value)
  const browserAvailable = useBrowserAvailable(value => value)
  const settings = useSettings(value => value)
  if (!browserAvailable) return null
  return (
    <SettingsSelectRow
      prefix="settings.links"
      settings={settings}
      options={OPTIONS}
      selectedId={destination}
      onSelect={(id) => { setLinkOpening(id as LinkOpening) }}
      t={t}
    />
  )
}
