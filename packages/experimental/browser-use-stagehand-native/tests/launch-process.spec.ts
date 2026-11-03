/** Failed executable startup emits close without exit and must not hang cleanup. */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchChromium } from '../src/launch.ts'

it('releases a real failed spawn without waiting for an exit event', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LocalSubprocessRuntime)
  await expect(launchChromium({
    executablePath: join(tmpdir(), `missing-browser-${randomUUID()}`),
    headless: true, operationTimeoutMs: 5000, processGraceMs: 50, processCloseTimeoutMs: 5000,
  }, new AbortController().signal, ctx.subprocess, SessionId('failed-chromium'))).rejects.toThrow(/ENOENT|before reporting/u)
})
