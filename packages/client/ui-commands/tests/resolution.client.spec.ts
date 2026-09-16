import { describe, expect, it } from 'vitest'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { CommandDescriptor } from '../src/client/directory.ts'
import { builtinCommandName, claimToken, resolveCommand } from '../src/client/resolution.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh)

function descriptor(name: string, definitionId?: string): CommandDescriptor {
  return {
    name,
    description: `${name} command`,
    ...(definitionId === undefined ? {} : { definitionId: CommandDefinitionId(definitionId) }),
  }
}

describe('builtinCommandName', () => {
  it('identifies first-party definitions by id, never by display name', () => {
    expect(builtinCommandName(descriptor('goal', '@deepseek-ai/dsh-command-goal'))).toBe('goal')
    expect(builtinCommandName(descriptor('compact', '@deepseek-ai/dsh-command-compact'))).toBe('compact')
    // A third-party command borrowing a builtin's name stays unidentified.
    expect(builtinCommandName(descriptor('goal', '@third-party/goal'))).toBeUndefined()
    expect(builtinCommandName(descriptor('attach'))).toBeUndefined()
  })
})

describe('claimToken', () => {
  it('returns the localized spelling for builtins and the registered name otherwise', () => {
    expect(claimToken(descriptor('goal', '@deepseek-ai/dsh-command-goal'), t)).toBe('目标')
    expect(claimToken(descriptor('attach'), t)).toBe('attach')
    expect(claimToken(descriptor('goal', '@third-party/goal'), t)).toBe('goal')
  })
})

describe('resolveCommand', () => {
  const catalog = [
    descriptor('goal', '@deepseek-ai/dsh-command-goal'),
    descriptor('plan', '@deepseek-ai/dsh-plan-mode'),
    descriptor('attach'),
  ]

  it('matches an exact typed name first', () => {
    expect(resolveCommand('attach', catalog)).toBe(catalog[2])
    expect(resolveCommand('goal', catalog)).toBe(catalog[0])
  })

  it('matches localized aliases only against the owning definition', () => {
    expect(resolveCommand('目标', catalog)).toBe(catalog[0])
    expect(resolveCommand('plan', catalog)).toBe(catalog[1])
    expect(resolveCommand(en['token.permission'], [])).toBeUndefined()
    expect(resolveCommand('nonexistent', catalog)).toBeUndefined()
  })
})
