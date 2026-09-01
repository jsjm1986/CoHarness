import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'

describe('Loader internal shape detection', () => {
  it('classifies the running Node loader by the resolver API it exposes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-loader-shape-'))
    const baseUrl = `${pathToFileURL(dir).href}/`
    const ctx = new Context()
    ctx.baseUrl = baseUrl
    await ctx.plugin(Loader)
    try {
      const internal = ctx.loader.internal
      expect(internal, 'Node module internals are required by HMR and module resolution').toBeDefined()
      const resolved = internal!.version === 'v2'
        ? internal!.resolveSync(baseUrl, { specifier: 'node:path', attributes: {} })
        : internal!.resolveSync('node:path', baseUrl, {})
      expect(resolved.url).toBe('node:path')
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
