/**
 * Package-local glyph for the changed-files card until the shared icon set
 * carries it; its props already match the shared icon contract.
 */
import { IconCodeOutline16, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** Angle brackets, the code mark the card's header tile shows. */
export const IconCodeBracketsOutline16 = ({ size = 16, className }: IconProps) => (
  <IconCodeOutline16 size={size} className={className} aria-hidden="true" />
)
