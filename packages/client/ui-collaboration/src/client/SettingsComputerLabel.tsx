/** Identifies the Host whose Runtime configuration the settings panel edits. @module */
import { Button, ComputerBadge, IconRightUpOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScopeControlProps } from './ScopeControl.tsx'
import css from './ScopeControl.module.css'

type SettingsComputerProps = Pick<ScopeControlProps, 'useCollaboration' | 'useDeployment' | 't' | 'openEnvironmentPickerTab'>

/**
 * Keep configuration ownership fixed while conversations navigate between computers.
 * @param props - verified bootstrap environment and localized identity label.
 * @returns the settings computer label, or null outside a verified Gateway environment.
 */
export function SettingsComputerLabel({ useDeployment, useCollaboration, t, openEnvironmentPickerTab }: SettingsComputerProps) {
  const policy = useDeployment(snapshot => snapshot)
  const state = useCollaboration(snapshot => snapshot)
  const name = state.context?.environment?.nodeName
  if (!policy.showComputer || !state.contextVerified || name === undefined) return null
  return <span className={css.configurationComputer}>
    <ComputerBadge name={name} label={t('computer.settingsLabel')} />
    {policy.aggregateComputers && openEnvironmentPickerTab !== undefined && <Tooltip label={t('computer.manageOther')} portal>
      <Button variant="ghost" size="sm" className={css.openConfigurationEnvironment}
        aria-label={t('computer.manageOther')} onClick={openEnvironmentPickerTab}>
        <IconRightUpOutline16 />
      </Button>
    </Tooltip>}
  </span>
}
