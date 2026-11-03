#!/usr/bin/env node
/** Default selection and live authorization in an assembled Loader application. */
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { boot, loadOptionalPatches, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-model-access'
import type {} from '@deepseek-ai/dsh-model-provider-config'

const config = process.argv[2]
const home = process.env.DSH_HOME
const control = process.env.DSH_POLICY_FIXTURE_CONTROL
if (config === undefined || home === undefined || control === undefined) throw new Error('policy snapshot requires configuration, home, and control endpoint')
const ctx = await boot('model-policy-snapshot', resolveConfigPath(config, undefined), loadOptionalPatches('model-policy-snapshot', join(home, 'cordis.patch.yml')))
try {
  const target = ctx.agentDefaultModel.currentSelection()
  process.stdout.write(`${JSON.stringify({ type: 'default', provider: target.provider, model: target.model })}\n`)
  for await (const chunk of ctx.llm.stream({ ...target, messages: [] })) {
    if (chunk.type === 'finish') process.stdout.write(`${JSON.stringify({ type: 'request-before', finish: chunk.reason.kind })}\n`)
  }
  const revoked = new Promise<void>((resolve) => {
    const dispose = ctx.on('model-provider-config/updated', () => {
      if (ctx.modelAccess.decide(target).allowed) return
      dispose()
      resolve()
    })
  })
  const response = await fetch(`${control}/revoke`, { method: 'POST' })
  if (!response.ok) throw new Error(await response.text())
  const waiting = new AbortController()
  try {
    // The production watcher is unreferenced; this one-shot host owns the wait.
    await Promise.race([
      revoked,
      delay(10_000, undefined, { signal: waiting.signal }).then(() => { throw new Error('live model policy did not revoke the route') }),
    ])
  } finally { waiting.abort() }
  for await (const chunk of ctx.llm.stream({ ...target, messages: [] })) {
    if (chunk.type === 'finish') process.stdout.write(`${JSON.stringify({
      type: 'request-after', finish: chunk.reason.kind,
      ...chunk.reason.kind === 'error' ? { code: chunk.reason.failure.code } : {},
    })}\n`)
  }
} finally { await ctx.fiber.dispose() }
