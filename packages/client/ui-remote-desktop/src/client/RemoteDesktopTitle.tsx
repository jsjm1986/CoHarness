/** Remote endpoint identity in the sidebar tab strip. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './face.ts'

/**
 * Distinguish open desktop connections using their current navigation target.
 * @param props - the live sidebar title occurrence.
 * @returns the node and optional desktop, or the tab's initial title before targeting.
 */
export function RemoteDesktopTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const { tab } = useTabInfo()
  const params = tab.navigation.params
  const label = params !== undefined && 'nodeId' in params
    ? params.desktop === undefined ? params.nodeId : `${params.nodeId} · ${params.desktop}`
    : tab.title
  return <span>{label}</span>
}
