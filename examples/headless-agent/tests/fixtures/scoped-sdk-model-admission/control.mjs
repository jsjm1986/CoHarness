/** Actual SDK-created Agents carry different model and capacity services from their provider. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'

/** Provide scoped policy and capacity without changing the provider's root services. */
export function apply(ctx, config) {
  const state = { admissions: [], released: [], uncertain: [], processRefused: false, childStopped: false, allParentSession: true }
  ctx.provide('sdkScopedAdmissionState', state)
  ctx.provide('modelAccess', { decide(target) {
    return target.provider === 'owned-sdk-child' && config.mode === 'model-denied'
      ? { allowed: false, reason: 'Scoped SDK model access refused.' } : { allowed: true }
  } })
  ctx.provide('resourceBudget', { async acquire(request) {
    state.admissions.push(request.kind)
    state.allParentSession &&= request.sessionId === 'sdk-scope-owner'
    if (request.kind === 'process' && config.mode === 'process-denied') {
      state.processRefused = true
      throw new ResourceAdmissionError('refused', 'Scoped SDK process admission refused.')
    }
    return { signal: new AbortController().signal,
      async release() {
        if (request.kind === 'process') {
          const child = JSON.parse(readFileSync(join(process.cwd(), '.sdk-child-process.json'), 'utf8'))
          assert.notEqual(child.pid, process.pid)
          assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
          state.childStopped = true
        }
        state.released.push(request.kind)
      }, async uncertain() { state.uncertain.push(request.kind) },
    }
  } })
  ctx.provide('sdkScopedAdmissionReady', true)
}
