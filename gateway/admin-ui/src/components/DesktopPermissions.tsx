/** Project desktop eligibility editor; user qualification lives on the user detail page. */
import { useMemo } from 'react'
import { getDesktopPolicy, setDesktopPolicy } from '../api.ts'
import { adminLanguage, translateCopy } from '../language.ts'
import { zh, en } from './permissions.copy.ts'
import { ResourcePermissions } from './ResourcePermissions.tsx'

export function DesktopPermissions() {
  const t = useMemo(() => translateCopy(adminLanguage(), { zh, en }), [])
  return <ResourcePermissions name={t('desktopName')} read={getDesktopPolicy} write={setDesktopPolicy} kinds={['project']}
    description={t('desktopDescription')}
    saved={t('desktopSaved')} />
}
