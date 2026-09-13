/** Composer command menu grouping, localized labels, descriptions, and icons. */
import type { ComponentType } from 'react'
import type { InputTriggerCandidate } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  IconCompactOutline16, IconDownloadOutline16, IconGoalOutline16, IconPlanOutline14, IconSendOutline16,
  IconShieldOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { CommandDescriptor } from './directory.ts'
import type { CommandKey } from './locales.ts'
import { builtinCommandName } from './resolution.ts'
import type { BuiltinCommandName } from './resolution.ts'

/** The menu's two sections. */
export type MenuSection = 'add' | 'commands'

/** Stable row order for the empty-query menu. Unlisted commands follow in catalog order. */
const SECTION_ROWS: Readonly<Record<MenuSection, readonly string[]>> = {
  add: ['file', 'goal', 'plan', 'feedback'],
  commands: ['compact', 'permission', 'model', 'export'],
}

interface HostFace {
  readonly label: CommandKey
  readonly description: CommandKey
  readonly icon: ComponentType<IconProps>
}

function hostFace(name: BuiltinCommandName, icon: ComponentType<IconProps>): readonly [BuiltinCommandName, HostFace] {
  return [name, {
    label: `label.${name}`,
    description: `description.${name}`,
    icon,
  }]
}

const HOST_FACES: ReadonlyMap<BuiltinCommandName, HostFace> = new Map([
  hostFace('goal', IconGoalOutline16),
  hostFace('plan', IconPlanOutline14),
  hostFace('feedback', IconSendOutline16),
  hostFace('compact', IconCompactOutline16),
  hostFace('permission', IconShieldOutline16),
  hostFace('export', IconDownloadOutline16),
])

/**
 * Return the localized face for a first-party Host command, or undefined for extensions.
 * @param descriptor - effective Host command descriptor.
 * @param t - command namespace translator.
 * @returns display fields for a known first-party command, or undefined.
 */
export function builtinRowFace(
  descriptor: CommandDescriptor,
  t: TranslateNS<'command'>,
): Pick<InputTriggerCandidate, 'label' | 'description' | 'icon'> | undefined {
  const name = builtinCommandName(descriptor)
  const face = name === undefined ? undefined : HOST_FACES.get(name)
  return face === undefined ? undefined : { label: t(face.label), description: t(face.description), icon: face.icon }
}

/**
 * Arrange an empty-query candidate list into Add and Commands sections.
 * @param rows - visible candidates in catalog/contribution order.
 * @param t - command namespace translator.
 * @returns candidates with section headings attached.
 */
export function sectionRows(rows: readonly InputTriggerCandidate[], t: TranslateNS<'command'>): readonly InputTriggerCandidate[] {
  const listed = new Set([...SECTION_ROWS.add, ...SECTION_ROWS.commands])
  const byName = new Map(rows.map(row => [row.name, row]))
  const pick = (names: readonly string[]): InputTriggerCandidate[] => names.flatMap((name) => {
    const row = byName.get(name)
    return row === undefined ? [] : [row]
  })
  const add = pick(SECTION_ROWS.add).map(row => ({ ...row, section: t('section.add') }))
  const commands = [...pick(SECTION_ROWS.commands), ...rows.filter(row => !listed.has(row.name))]
    .map(row => ({ ...row, section: t('section.commands') }))
  return [...add, ...commands]
}
