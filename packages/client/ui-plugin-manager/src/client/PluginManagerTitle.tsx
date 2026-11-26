/** Header title provided for the compact Plugins panel. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createNavigationStore } from './navigation-store.ts'
import type { PluginManagerPageProps } from './PluginManagerPage.tsx'
import { listedPackages, packageText, rowText } from './presentation.ts'

type PluginManagerTitleProps = PropsRuntime<'shell.mobile.header.title'>
  & PropsLocale<'pluginManager'>
  & PropsStore<ReturnType<typeof createNavigationStore>>
  & Pick<PluginManagerPageProps, 'usePluginManager' | 'useConfigLedger' | 'usePluginTabs' | 'resolveText'>

/**
 * Render the selected plugin page's localized title in the compact shell.
 * @param props - shared navigation, catalogs and locale.
 * @returns the active tab, plugin or bundle title, or the Plugins list title.
 */
export function PluginManagerTitle(props: PluginManagerTitleProps): ReactNode {
  const { view, tab } = props.useStore(state => state)
  const packages = props.usePluginManager(state => state.packages)
  const items = props.useConfigLedger(state => state.items)
  const tabs = props.usePluginTabs(state => state)
  const contributedTab = tabs.find(item => item.id === tab)
  if (contributedTab !== undefined) return contributedTab.label
  if (view.kind === 'item') return items.find(item => item.id === view.id)?.label ?? props.t('title')
  if (view.kind === 'package' || view.kind === 'row') {
    const pkg = listedPackages(packages).find(item => item.name === view.name)
    if (pkg === undefined) return props.t('title')
    const row = view.kind === 'row' ? pkg.rows.find(item => item.rowId === view.rowId) : undefined
    return row === undefined ? packageText(pkg, props.resolveText).title : rowText(row, props.resolveText).title
  }
  return props.t(view.kind === 'more' ? 'moreTitle' : 'title')
}
