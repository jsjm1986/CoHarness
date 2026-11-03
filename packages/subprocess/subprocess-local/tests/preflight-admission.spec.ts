/** Known local validation failures return their permit before another physical launch. */
import { Context } from '@deepseek-ai/cordis'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import LocalSubprocessRuntime from '../src/index.ts'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { expect, it } from 'vitest'

const ordinary: SubprocessSpawnSpec = { argv: [process.execPath, '-e', ''], cwd: process.cwd(), graceMs: 100,
  stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } }
const terminal: SubprocessTerminalSpawnSpec = { argv: [process.execPath], cwd: process.cwd(), graceMs: 100,
  cols: 80, rows: 24, terminalType: 'dumb' }

it.each([
  { name: 'empty ordinary argv', kind: 'ordinary', spec: { ...ordinary, argv: [] } },
  { name: 'empty ordinary program', kind: 'ordinary', spec: { ...ordinary, argv: [''] } },
  ...[0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31].map(graceMs => ({
    name: `invalid ordinary grace ${graceMs}`, kind: 'ordinary', spec: { ...ordinary, graceMs },
  })),
  { name: 'empty terminal argv', kind: 'terminal', spec: { ...terminal, argv: [] } },
  { name: 'empty terminal program', kind: 'terminal', spec: { ...terminal, argv: [''] } },
  ...(['ordinary', 'terminal'] as const).flatMap((kind) => {
    const base = kind === 'ordinary' ? ordinary : terminal
    return [
      { name: `NUL ${kind} program`, kind, spec: { ...base, argv: ['bad\0program'] } },
      { name: `NUL ${kind} argument`, kind, spec: { ...base, argv: [process.execPath, 'bad\0argument'] } },
      { name: `NUL ${kind} directory`, kind, spec: { ...base, cwd: process.cwd() + '\0' } },
      { name: `NUL ${kind} environment key`, kind, spec: { ...base, env: { ['bad\0key']: 'value' } } },
      { name: `NUL ${kind} environment value`, kind, spec: { ...base, env: { DSH_TEST_INVALID_VALUE: 'bad\0value' } } },
    ]
  }),
])('returns unused capacity after $name', async ({ name, kind, spec }) => {
  const ctx = new Context(), leases: Array<{ released: boolean; uncertain: boolean }> = []
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    ctx.provide('resourceBudgetRequired', true)
    ctx.provide('resourceBudget', { acquire: async () => {
      if (leases.some(entry => !entry.released)) throw new ResourceAdmissionError('refused', 'The only process slot is occupied.')
      const entry = { released: false, uncertain: false }
      leases.push(entry)
      return { signal: new AbortController().signal, release: async () => { entry.released = true },
        uncertain: async () => { entry.uncertain = true } }
    } })
    const rejected = kind === 'ordinary' ? ctx.subprocess.spawn(spec as SubprocessSpawnSpec)
      : ctx.subprocess.spawnTerminal(spec as SubprocessTerminalSpawnSpec)
    await expect(rejected).rejects.toThrow(name.startsWith('NUL') ? 'must be a string without null bytes'
      : kind === 'terminal' ? 'must contain a program'
        : spec.graceMs === 100 ? 'invalid argv' : 'graceMs must be a positive finite number')
    if (name.startsWith('NUL')) await expect(rejected).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
    expect(leases).toEqual([{ released: true, uncertain: false }])
    const handle = await ctx.subprocess.spawn(ordinary)
    handle.stdout?.resume()
    handle.stderr?.resume()
    await expect(handle.done).resolves.toMatchObject({ exitCode: 0 })
    await expect(handle.waitForExit()).resolves.toBe(true)
    expect(leases).toEqual([{ released: true, uncertain: false }, { released: true, uncertain: false }])
  } finally { await ctx.fiber.dispose() }
})
