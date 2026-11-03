/** Actual nested SDK runtime under a parent-owned process permit. */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'node:util'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import ModelAccessPolicy from '@deepseek-ai/dsh-model-access'
import { materializeProfilePatch } from '@deepseek-ai/dsh-session-snapshot'
import Subagents from '@deepseek-ai/dsh-subagent'
import * as Sdk from '@deepseek-ai/dsh-subagent-dsh-sdk'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'

export const inject = ['llm', 'agents', 'workingDirectory']

function reply(text) {
  return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }]
}

/** Install the owned parent or child composition without provider network calls. */
export async function apply(ctx, config) {
  const marker = join(process.cwd(), '.sdk-child-process.json')
  const native = config.mode === 'native' || config.mode === 'native-sonar'
  const sonar = config.mode === 'native-sonar'
  const scoped = config.mode.startsWith('scope-')
  if (config.role === 'child') {
    const controlHidden = process.env.DSH_SDK_PARENT_CONTROL === undefined
      && ctx.get('launchEnvironment')?.get('DSH_SDK_PARENT_CONTROL') === undefined
    writeFileSync(marker, JSON.stringify({ pid: process.pid, ranModel: false, controlHidden }))
    if (native) { ctx.provide('sdkProcessAdmissionReady', true); return }
    class Child extends LlmAdapter {
      async resolveModel(provider, model) {
        return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('max'), name: 'Maximum' }] } }
      }
      async *stream(options) {
        assert.equal(options.reasoningEffort, 'max')
        writeFileSync(marker, JSON.stringify({ pid: process.pid, ranModel: true, reasoningEffort: options.reasoningEffort, controlHidden }))
        yield* reply('CHILD_MODEL_DONE')
      }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['owned-sdk-child'], new Child()))
    ctx.provide('sdkProcessAdmissionReady', true)
    return
  }
  const diagnostics = join(process.cwd(), '.sdk-process-diagnostics.log')
  writeFileSync(diagnostics, '', { mode: 0o600 })
  ctx.logger.exporter({ levels: { default: 4 }, export(message) {
    if (message.type === 'warn' || message.type === 'error') appendFileSync(diagnostics, `${format(...message.args)}\n`)
  } })
  class ParentPolicy extends ModelAccessPolicy { decide() { return { allowed: true } } }
  if (native) {
    const filename = join(process.cwd(), '.sdk-parent-governance.json')
    writeFileSync(filename, JSON.stringify({ version: 1, defaultAllowed: false, userDeclaredAllowed: true, providers: [],
      models: [['owned-sdk-parent', 'm'], ['native-fixture', 'conversation'],
        [sonar ? 'sonar-owned' : 'deepseek-official', sonar ? 'sonar' : 'deepseek-v4-flash']].map(([provider, model]) => ({ provider, model, allowed: true })),
      intakeUrl: 'http://127.0.0.1:1/usage', intakeToken: 'owned-sdk-intake-token',
    }))
    process.env.DSH_MODEL_GOVERNANCE = filename
    await ctx.plugin(await import(new URL('../../../../../plugins/dsh-model-governance/lib/index.js', import.meta.url).href))
  } else await ctx.plugin(ParentPolicy)
  ctx.provide('modelAccessRequired', true)
  const admissions = [], released = [], uncertain = []
  let processRefused = false, childStopped = false
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('resourceBudget', { async acquire(request) {
    admissions.push(request.kind)
    if (request.kind === 'process' && config.mode === 'refused') {
      processRefused = true
      throw new ResourceAdmissionError('refused', 'SDK child process admission refused by fixture.')
    }
    return { signal: new AbortController().signal, async release() {
      if (request.kind === 'process') {
        const child = JSON.parse(readFileSync(marker, 'utf8'))
        assert.notEqual(child.pid, process.pid)
        assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' })
        childStopped = true
      }
      released.push(request.kind)
    }, async uncertain() { uncertain.push(request.kind) } }
  } })
  const childPatch = join(process.cwd(), '.sdk-child.patch.yml')
  writeFileSync(childPatch, `- id: llm-deepseek\n  disabled: true\n- id: sdk-jsonrpc-server\n  inject: [sdkAppStartup, loader, sdkProcessAdmissionReady]\n- insert:\n    - id: sdk-child-fixture\n      name: ${JSON.stringify(fileURLToPath(import.meta.url))}\n      config: { role: child, mode: ${JSON.stringify(config.mode)} }\n`)
  const patches = [childPatch]
  let childHome = join(process.cwd(), '.sdk-child-home')
  if (native) {
    const childRoot = join(process.cwd(), '.sdk-native-child')
    childHome = join(childRoot, '.dsh')
    const patchRoot = join(childRoot, '.patches')
    mkdirSync(patchRoot, { recursive: true })
    patches.push(materializeProfilePatch(fileURLToPath(new URL(`../${sonar ? 'governed-sonar-model' : 'governed-native-model'}/runtime.cordis.yml`, import.meta.url)),
      childRoot, 'sdk-minimal', patchRoot, 0))
    const settings = join(patchRoot, 'native-parent.patch.yml')
    writeFileSync(settings, `- id: native-model-fixture\n  config:\n    protocol: ${sonar ? 'sonar' : 'messages'}\n    inheritParentAdmission: true\n    completionFile: ${JSON.stringify(marker)}\n`)
    patches.push(settings)
  }
  await ctx.plugin(Subagents)
  await ctx.plugin(Sdk, { providerName: 'owned-sdk', profile: 'sdk-minimal', patches,
    dshHome: childHome, provider: native ? 'native-fixture' : 'owned-sdk-child', model: native ? 'conversation' : 'm',
    ...native ? {} : { reasoningEffort: ReasoningEffortId('max') },
    initializeTimeoutMs: 30_000, shutdownTimeoutMs: 5_000, disposeEofGraceMs: 10_000, disposeGraceMs: 5_000,
    env: { DSH_TELEMETRY_DISABLED: '1', DSH_AGENTS_HOME: join(process.cwd(), '.sdk-child-agents') },
  })
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.inject(ToolSubagent.inject, scope => ToolSubagent.apply(scope, { provider: 'owned-sdk',
      enableRunInBackground: false, maxDepth: 'provider-managed', modelSelectionSettings: false,
    }, agent.session))
  })
  class Parent extends LlmAdapter {
    async *stream(options) {
      const result = options.messages.findLast(message => message.role === 'tool')
      if (result === undefined) {
        const id = ToolCallId('owned-sdk-child'), name = 'subagent'
        const args = JSON.stringify({ description: 'Owned SDK child', prompt: 'Return the owned child result.' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      assert(text.includes(config.mode === 'scope-process-denied' ? 'Scoped SDK process admission refused.'
        : config.mode === 'scope-model-denied' ? 'subagent run failed'
        : processRefused ? 'SDK child process admission refused by fixture.' : native ? 'NATIVE_SEARCH_DONE' : 'CHILD_MODEL_DONE'))
      yield* reply('SDK_PROCESS_DONE')
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['owned-sdk-parent', 'owned-sdk-child'], new Parent()))
  ctx.on('agent/turn-stopping', ({ agent }) => {
    const child = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : undefined
    const records = native ? readdirSync(join(process.env.DSH_HOME, 'model-governance-outbox')).filter(name => name.endsWith('.json'))
      .map(name => JSON.parse(readFileSync(join(process.env.DSH_HOME, 'model-governance-outbox', name), 'utf8'))) : []
    appendPluginRecord(agent.session, 'plugin:sdk-process-admission/complete', {
      admissions, released, uncertain, processRefused, childRan: child?.ranModel === true, childStopped,
      ...scoped ? { scoped: ctx.get('sdkScopedAdmissionState') } : {},
      ...child === undefined ? {} : { ...child.reasoningEffort === undefined ? {} : { childReasoningEffort: child.reasoningEffort },
        childControlHidden: child.controlHidden },
      ...native ? { nativeChild: child?.native, governance: { records: records.length,
        allParentSession: records.every(record => record.sessionId === String(agent.id)),
        nativeUsage: records.filter(record => record.purpose === 'web-search').map(record => ({ provider: record.provider, model: record.model,
          credentialSource: record.credentialSource, credentialClass: record.credentialClass, status: record.status, usage: record.usage })),
      } } : {},
    })
  })
  ctx.provide('sdkProcessAdmissionReady', true)
}
