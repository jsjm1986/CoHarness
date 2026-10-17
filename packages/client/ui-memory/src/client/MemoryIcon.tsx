/** Decorative occupant for the Memory sidebar entry. */
import { IconBrainOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the brain glyph at the size the sidebar asks for; the sidebar owns
 * its accessible navigation label.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns decorative brain icon.
 */
export function MemoryIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconBrainOutline16 size={size} />
}
