/**
 * The `settings.plugin.item` slot type — one plugin's card inside the
 * configurable-plugins tab, keyed by the settings namespace the card edits.
 * Options: `key` (the namespace). A card draws its own internals; the tab only
 * decides which namespaces to dispatch and stacks what comes back.
 *
 * Keying on the namespace lets a plugin distributed outside this repository
 * contribute a card without teaching this package what the namespace means.
 * The type lives with the tab that declares the slot at runtime.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** One plugin's card inside the plugin configuration section (see module JSDoc). */
    'settings.plugin.item': { kind: 'keyed'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface SettingsPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}
