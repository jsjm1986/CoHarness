/** Project plugin-management authorization editor; user qualification lives on the user detail page. */
import { useMemo } from 'react'
import { getPluginPolicy, setPluginPolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './permissions.copy.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function PluginPermissions() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <ResourcePermissions name={t('pluginName')} read={getPluginPolicy} write={setPluginPolicy} kinds={['project']}
    description={t('pluginDescription')}
    saved={t('pluginSaved')} />
}
