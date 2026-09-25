/** Tool detail presentation bound to the tab's durable address. */
import type { PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { parseToolAddress } from './address.ts'

/** Render the tool owner with this tab's identity and close action.
 * @param props - Session scope, tab information, and declared detail renderer.
 * @returns the tool owner's content.
 */
export function ToolBody({ sessionId, useTabInfo, renderSlot }: PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'details'>) {
  const { tab: { navigation, actions, visible } } = useTabInfo()
  const target = parseToolAddress(navigation.address)
  if (target === undefined || target.sessionId !== sessionId) throw new Error('Tool tab does not belong to this Session')
  return renderSlot('details', { callId: target.callId, readEnabled: visible, close: () => { actions.close() } })
}
