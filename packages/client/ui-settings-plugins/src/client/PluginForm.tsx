/**
 * One plugin's configuration form: the read-only banner, the controls a card
 * supplies, and the footer whose save writes the staged edits.
 *
 * The Plugins panel's detail page supplies the title, artwork, and crumb; this
 * form draws only the body. A form renders nothing while its namespace is
 * unavailable: a deployment that does not compose the owning plugin should
 * show no trace of it, rather than controls the user cannot act on.
 */

import type { ReactNode } from 'react'
import type { CardShell } from './card-form.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import css from './PluginForm.module.css'

/** Form chrome shared by every plugin card's page view. */
export interface PluginFormProps {
  /** Locale reader for this package's copy. */
  t: (key: PluginsSettingsLocaleKey) => string
  /** The form state: availability, writability, and what a save would do. */
  state: CardShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render one plugin's form body.
 * @param props - the form state, its write actions, and its controls.
 * @returns the form, or nothing when the namespace is unavailable.
 */
export function PluginForm(props: PluginFormProps) {
  const { state } = props
  if (!state.available) return null
  const blocked = !state.writable || !state.dirty || state.invalid || state.saving
  return (
    <div className={css.form}>
      {!state.writable ? (
        <p className={css.readOnly} role="status">
          {state.writableReason === 'project'
            ? props.t('readOnlyProject')
            : state.writableReason === 'account'
              ? props.t('readOnlyAccount')
              : state.writableReason === 'organization'
                ? props.t('readOnlyOrganization')
                : state.writableReason === 'deployment'
                  ? props.t('readOnlyDeployment')
                  : props.t('readOnly')}
        </p>
      ) : null}
      {props.children}
      <div className={css.footer}>
        {state.failed ? <p className={css.failed} role="status">{props.t('saveFailed')}</p> : null}
        {state.dirty ? <span className={css.pending}>{props.t('unsaved')}</span> : null}
        <button
          type="button"
          className={css.discard}
          disabled={!state.dirty || state.saving}
          onClick={props.onDiscard}
        >
          {props.t('discard')}
        </button>
        <button
          type="button"
          className={css.save}
          disabled={blocked}
          onClick={props.onSave}
        >
          {props.t(state.saving ? 'saving' : 'save')}
        </button>
      </div>
    </div>
  )
}
