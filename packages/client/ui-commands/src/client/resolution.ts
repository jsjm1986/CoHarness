/** Command identity and localized input spelling for first-party commands. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { CommandDescriptor } from './directory.ts'
import { en, zh } from './locales.ts'

const BUILTINS = {
  goal: '@deepseek-ai/dsh-command-goal',
  plan: '@deepseek-ai/dsh-plan-mode',
  feedback: '@deepseek-ai/dsh-command-feedback',
  compact: '@deepseek-ai/dsh-command-compact',
  permission: '@deepseek-ai/dsh-permission-presets',
  export: '@deepseek-ai/dsh-session-log-export',
} as const

/** Names whose first-party definitions have localized client presentation. */
export type BuiltinCommandName = keyof typeof BUILTINS

/**
 * Identify a first-party definition without relying on its display name or copy.
 * @param descriptor - effective command descriptor.
 * @returns first-party command name, or undefined for another definition.
 */
export function builtinCommandName(descriptor: CommandDescriptor): BuiltinCommandName | undefined {
  return (Object.keys(BUILTINS) as BuiltinCommandName[]).find(name => descriptor.definitionId === BUILTINS[name])
}

/**
 * Select the input spelling for a menu-picked command.
 * @param descriptor - effective command descriptor.
 * @param t - command namespace translator.
 * @returns localized spelling for a known definition, or its registered name.
 */
export function claimToken(descriptor: CommandDescriptor, t: TranslateNS<'command'>): string {
  const name = builtinCommandName(descriptor)
  return name === undefined ? descriptor.name : t(`token.${name}`)
}

const TOKEN_ALIASES = new Map(
  (Object.keys(BUILTINS) as BuiltinCommandName[]).flatMap(name =>
    [zh[`token.${name}`], en[`token.${name}`]].map(token => [token, name] as const)),
)

/**
 * Resolve a typed name against the current Session catalog, honoring localized aliases only for the matching definition.
 * @param token - typed command name without the leading slash.
 * @param descriptors - effective descriptors in the session catalog.
 * @returns matching descriptor, or undefined.
 */
export function resolveCommand(token: string, descriptors: readonly CommandDescriptor[]): CommandDescriptor | undefined {
  const exact = descriptors.find(descriptor => descriptor.name === token)
  if (exact !== undefined) return exact
  const name = TOKEN_ALIASES.get(token)
  return name === undefined ? undefined : descriptors.find(descriptor => descriptor.definitionId === BUILTINS[name])
}
