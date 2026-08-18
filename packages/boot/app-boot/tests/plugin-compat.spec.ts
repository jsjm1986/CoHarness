/**
 * Real Loader composition guard for the official rc.7 plugin entry formats:
 * named ESM function plugins, default-exported class plugins, and CommonJS
 * object plugins all mount from cordis.yml with injection and Standard Schema
 * configuration intact.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '../src/index.ts'

const NAME = 'dsh-plugin-compat-test'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('official rc.7 plugin format compatibility', () => {
  it('boots named ESM, default class, and CommonJS plugins through cordis.yml', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-plugin-compat-'))
    await writeFile(join(root, 'dependency.mjs'), [
      'export function apply(ctx) {',
      '  ctx.provide("fixtureDependency", { prefix: "ready" })',
      '}',
      '',
    ].join('\n'))
    await writeFile(join(root, 'function.mjs'), [
      'export const name = "official-function"',
      'export const inject = ["fixtureDependency"]',
      'export const Config = {',
      '  "~standard": {',
      '    version: 1,',
      '    vendor: "fixture",',
      '    validate(value) {',
      '      const input = value && typeof value === "object" ? value : {}',
      '      return { value: { label: String(input.label ?? "fallback").trim(), count: Number(input.count ?? 1) } }',
      '    },',
      '  },',
      '}',
      'export function apply(ctx, config) {',
      '  ctx.provide("officialFunctionState", { dependency: ctx.get("fixtureDependency").prefix, config })',
      '}',
      '',
    ].join('\n'))
    await writeFile(join(root, 'class.mjs'), [
      'export default class OfficialClassPlugin {',
      '  static inject = ["fixtureDependency"]',
      '  static Config = {',
      '    "~standard": {',
      '      version: 1,',
      '      vendor: "fixture",',
      '      validate(value) {',
      '        const input = value && typeof value === "object" ? value : {}',
      '        return { value: { mode: String(input.mode ?? "class").toUpperCase() } }',
      '      },',
      '    },',
      '  }',
      '  constructor(ctx, config) {',
      '    ctx.provide("officialClassState", { dependency: ctx.get("fixtureDependency").prefix, config })',
      '  }',
      '}',
      '',
    ].join('\n'))
    await writeFile(join(root, 'commonjs.cjs'), [
      'module.exports = {',
      '  name: "official-commonjs",',
      '  inject: ["fixtureDependency"],',
      '  Config: {',
      '    "~standard": {',
      '      version: 1,',
      '      vendor: "fixture",',
      '      validate(value) {',
      '        const input = value && typeof value === "object" ? value : {}',
      '        return { value: { channel: String(input.channel ?? "cjs").toLowerCase() } }',
      '      },',
      '    },',
      '  },',
      '  apply(ctx, config) {',
      '    ctx.provide("officialCommonJsState", { dependency: ctx.get("fixtureDependency").prefix, config })',
      '  },',
      '}',
      '',
    ].join('\n'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: function',
      '  name: ./function.mjs',
      '  config:',
      '    label: "  official  "',
      '    count: "3"',
      '- id: class',
      '  name: ./class.mjs',
      '  config:',
      '    mode: compatible',
      '- id: commonjs',
      '  name: ./commonjs.cjs',
      '  config:',
      '    channel: RC.7',
      '- id: dependency',
      '  name: ./dependency.mjs',
      '',
    ].join('\n'))

    context = await boot(NAME, configPath)

    expect(context.get('officialFunctionState')).toEqual({
      dependency: 'ready',
      config: { label: 'official', count: 3 },
    })
    expect(context.get('officialClassState')).toEqual({
      dependency: 'ready',
      config: { mode: 'COMPATIBLE' },
    })
    expect(context.get('officialCommonJsState')).toEqual({
      dependency: 'ready',
      config: { channel: 'rc.7' },
    })
  })
})
