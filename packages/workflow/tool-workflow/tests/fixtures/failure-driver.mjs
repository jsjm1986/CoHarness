/** Real background services and PTC cleanup retain settlement after error coercion fails. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const mode = process.argv[2]
if (mode !== 'src' && mode !== 'lib') throw new Error('Background fixture requires src or lib')
const artifact = mode === 'src' ? 'src/index.ts' : 'lib/index.js'
const entry = path => new URL(`../../../../${path}/${artifact}`, import.meta.url)
const { boot } = await import(entry('boot/app-boot'))
const { LlmAdapter, ToolCallId, createUserMessage } = await import(entry('llm/llm'))
const { SessionId } = await import(entry('core/session'))
const { settleRun } = await import(entry('subagent/subagent'))
const plugins = [
  ['core/session'], ['core/agent'], ['llm/llm'], ['core/tools'], ['core/system-prompt'],
  ['session/session-persistence-jsonl', { root: join(process.cwd(), 'sessions'), compression: 'none' }],
  ['session/session-projection'], ['core/agent-loop', { agents: [] }],
  ['jobs/jobs-local'], ['jobs/tool-jobs'],
  ['fs/fs-local'], ['session/working-directory'], ['subprocess/subprocess-local'], ['sandbox/sandbox-local'],
  ['sandbox/sandbox-policy', { mode: 'danger-full-access', workspaceRoot: process.cwd() }],
  ['shell/shell-env'], ['shell/bash-local'], ['shell/tool-bash'],
  ['ptc-runtime/ptc-runtime-node'], ['subagent/subagent'], ['workflow/workflow-ptc', { provider: 'failure-child' }], ['workflow/tool-workflow'],
]
const config = join(process.cwd(), 'cordis.yml')
await writeFile(config, JSON.stringify(plugins.map(([path, options]) => ({
  name: entry(path).href, ...(options === undefined ? {} : { config: options }),
}))))
const ctx = await boot('background-failure-fixture', config)
const warnings = [], warn = ctx.logger.warn, workflowCleanupFailed = Promise.withResolvers()
ctx.logger.warn = message => {
  const text = String(message)
  warnings.push(text)
  if (text.startsWith('background workflow run ') && text.includes(' dispose failed:')) workflowCleanupFailed.resolve()
}
const releases = []
const archiveGates = new Map()
class Adapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    const gate = archiveGates.get(options.sessionId)
    if (gate !== undefined) {
      gate.signal = options.signal
      gate.entered.resolve()
      await gate.release.promise
      options.signal.throwIfAborted()
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Background result observed.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Background result observed.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
try {
  ctx.llm.registerAdapter(['failure-fixture'], new Adapter())
  const parent = await ctx.agentLoop.create(SessionId('background-failure-fixture'), { provider: 'failure-fixture', model: 'fixture' }, { cwd: process.cwd() })
  const jobs = ctx.jobs, signal = new AbortController().signal
  const detach = jobs.events.subscribe({ owners: 'all' }, () => { throw Object.create(null) })
  releases.push(detach)
  const statuses = []
  for (const stage of ['producer', 'source']) {
    const terminal = Promise.withResolvers()
    releases.push(() => { terminal.resolve({ status: 'killed' }) })
    const id = jobs.start({
      kind: 'bash', label: `${stage} failure`, owner: parent.id,
      ...(stage === 'source' ? { output: [{ read() { throw Object.create(null) } }] } : {}),
      run: () => ({ cancel: () => { terminal.resolve({ status: 'killed' }) }, done: terminal.promise }),
    })
    const observerAbort = new AbortController()
    const stopObserverAbort = ctx.on('session/event', (session, event) => {
      if (session === parent.session && event.type === 'job/settled' && event.data.jobId === id) observerAbort.abort()
    })
    releases.push(stopObserverAbort)
    const waiting = jobs.wait(id, 10_000, parent.id, observerAbort.signal)
    if (stage === 'producer') terminal.reject(Object.create(null))
    else terminal.resolve({ status: 'completed' })
    const result = await waiting
    assert.equal(observerAbort.signal.aborted, true)
    stopObserverAbort()
    assert.equal(result.status, stage === 'producer' ? 'failed' : 'completed')
    statuses.push({ stage, status: result.status })
  }
  detach()
  let childDisposed = false
  ctx.subagents.registerProvider({
    name: 'failure-child', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => ({
      id: SessionId('unrenderable-child'), localAgent: undefined,
      result: Promise.reject(Object.create(null)),
      dispose: async () => { childDisposed = true },
    }),
  })
  const child = await ctx.subagents.start('failure-child', { parent, prompt: 'Fail the child request.', signal })
  const childOutcome = await settleRun(child)
  assert.equal(childOutcome.status, 'failed')
  assert.equal(childDisposed, true)
  const start = ctx.workflowEngine.start.bind(ctx.workflowEngine)
  let workflowDisposed = false, allowWorkflowCleanup = false, workflowDisposals = 0
  ctx.workflowEngine.start = request => {
    const run = start(request)
    return { ...run, cancel: reason => run.cancel(reason), dispose: async () => {
      workflowDisposals++
      await run.dispose()
      workflowDisposed = true
      if (!allowWorkflowCleanup) throw Object.create(null)
    } }
  }
  const accepted = await ctx.tools.execute({
    signal, callId: ToolCallId('background-failure-workflow'), name: 'workflow',
    arguments: { script: 'return { released: true }', meta: { name: 'failure-flow', description: 'Retain the real workflow result after cleanup reporting fails.' }, run_in_background: true },
    agent: parent,
  })
  ctx.workflowEngine.start = start
  assert.equal(accepted.isError, false, JSON.stringify(accepted))
  const { jobId, runId } = accepted.value
  releases.push(async () => {
    allowWorkflowCleanup = true
    if (jobs.list(parent.id).some(job => job.id === jobId)) {
      jobs.kill(jobId, parent.id, 'fixture cleanup')
      await jobs.wait(jobId, 30_000, parent.id)
    }
  })
  await workflowCleanupFailed.promise
  assert.equal(jobs.get(jobId, parent.id).status, 'running')
  allowWorkflowCleanup = true
  jobs.kill(jobId, parent.id, 'retry workflow cleanup')
  const workflow = await jobs.wait(jobId, 30_000, parent.id)
  assert.equal(workflow.status, 'failed')
  assert.equal(workflowDisposals, 2)
  assert.equal(workflowDisposed, true)
  const collected = await ctx.tools.execute({ signal, callId: ToolCallId('background-failure-output'), name: 'job_output', arguments: { job_id: jobId }, agent: parent })
  assert.equal(collected.isError, false)
  assert.ok(collected.content.some(block => block.type === 'text' && block.text.includes('Workflow cleanup failed')))
  assert.ok(!collected.content.some(block => block.type === 'text' && block.text.includes('"released": true')))
  const ended = parent.session.snapshotEvents().some(event => event.type === 'tool-workflow/run-end' && event.data.runId === runId)
  assert.equal(ended, true)
  assert.ok(warnings.some(message => message.includes('dispose failed: [unrenderable thrown value]')))
  const bash = await ctx.tools.execute({ signal, callId: ToolCallId('durable-bash'), name: 'bash',
    arguments: { command: 'echo durable-job', description: 'Verify durable job attribution', run_in_background: true }, agent: parent })
  assert.equal(bash.isError, false, JSON.stringify(bash))
  assert.equal((await jobs.wait(bash.value.jobId, 10_000, parent.id)).status, 'completed')
  const publication = Promise.withResolvers(), publicationOrder = []
  let publicationHandle
  releases.push(() => { publication.resolve({ status: 'killed' }) })
  const duringRecord = ctx.on('session/event', (session, event) => {
    if (session !== parent.session || event.type !== 'job/registered' || event.data.label !== 'publication-order') return
    jobs.kill(event.data.jobId, parent.id, 'cancelled by a journal observer')
  })
  releases.push(duringRecord)
  const publicationStops = ['first', 'second'].map(label => jobs.events.subscribe({ owners: 'all' }, event => {
    const id = event.type === 'output' ? event.id : event.job.id
    if (id !== publicationHandle?.id) return
    publicationOrder.push(`${label}:${event.type}`)
    if (label === 'first' && event.type === 'registered') publicationHandle.append('first producer output')
  }))
  releases.push(...publicationStops)
  const publicationId = jobs.start({ kind: 'bash', label: 'publication-order', owner: parent.id, run: handle => {
    publicationHandle = handle
    return { cancel: () => { publication.resolve({ status: 'killed' }) }, done: publication.promise }
  } })
  const initialPublicationOrder = [...publicationOrder]
  assert.deepEqual(initialPublicationOrder, ['first:registered', 'second:registered', 'first:stopping', 'second:stopping', 'first:output', 'second:output'])
  assert.equal((await jobs.wait(publicationId, 10_000, parent.id)).status, 'killed')
  for (const stop of publicationStops) stop()
  duringRecord()
  ctx.subagents.registerProvider({
    name: 'failure-start', inheritsParentContext: false,
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    start: async () => { throw Object.create(null) },
  })
  await ctx.plugin(await import(entry('subagent/tool-subagent')), { provider: 'failure-start', maxDepth: 'provider-managed' })
  const failedStart = await ctx.tools.execute({ signal, callId: ToolCallId('failed-subagent-start'), name: 'subagent',
    arguments: { description: 'startup failure', prompt: 'Fail before child publication.', run_in_background: true }, agent: parent })
  assert.equal(failedStart.isError, false, JSON.stringify(failedStart))
  const failedStartState = await jobs.wait(failedStart.value.jobId, 10_000, parent.id)
  assert.equal(failedStartState.status, 'failed')
  assert.equal(failedStartState.detail, '<unrenderable thrown value>')
  const startupRecord = parent.session.snapshotEvents().find(event => event.type === 'job/settled' && event.data.jobId === failedStart.value.jobId)
  assert.equal(startupRecord.data.producerReported, true)
  const archiveTerminal = [Promise.withResolvers(), Promise.withResolvers()]
  for (const terminal of archiveTerminal) releases.push(() => { terminal.resolve({ status: 'killed' }) })
  const archiveJobs = archiveTerminal.map((terminal, index) => jobs.start({ kind: 'bash', owner: parent.id,
    label: `archive-cancel-${index}`, run: () => ({
      cancel: () => { if (index === 0) throw Object.create(null); terminal.resolve({ status: 'killed' }) }, done: terminal.promise,
    }) }))
  const archiveChildren = []
  for (const name of ['archive-first-child', 'archive-second-child']) {
    const childId = SessionId(name), gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
    archiveGates.set(childId, gate)
    releases.push(() => { gate.release.resolve() })
    const handle = await ctx.agents.create({ sessionId: childId, parentAgent: parent,
      meta: { parentSession: parent.id, origin: 'subagent' }, agentOptions: { provider: 'failure-fixture', model: 'fixture' } })
    archiveChildren.push(handle)
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Remain in the running model request until archive cancellation is observed.' }], source: { kind: 'user' } }))
    await gate.entered.promise
  }
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId: parent.id }, () => Promise.resolve([]))
  assert.deepEqual(activity.find(family => family.kind === 'subagent').items.map(child => child.id), archiveChildren.map(child => child.agent.id))
  const firstChild = archiveChildren[0].agent, cancelFirst = firstChild.cancel
  firstChild.cancel = () => { throw Object.create(null) }
  try {
    await ctx.parallel('workspace/session-stop', { sessionId: parent.id })
    assert.equal(archiveGates.get(archiveChildren[1].agent.id).signal.aborted, true)
    assert.equal((await jobs.wait(archiveJobs[1], 10_000, parent.id)).status, 'killed')
  } finally {
    firstChild.cancel = cancelFirst
    firstChild.cancel({ kind: 'parent' })
    for (const gate of archiveGates.values()) gate.release.resolve()
    archiveTerminal[0].resolve({ status: 'completed' })
  }
  await Promise.all(archiveChildren.map(handle => handle.dispose()))
  assert.equal((await jobs.wait(archiveJobs[0], 10_000, parent.id)).status, 'completed')
  const cancelObservers = []
  for (const kind of ['session', 'agent']) {
    const childId = SessionId(`cancel-${kind}-observer`), gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
    archiveGates.set(childId, gate)
    releases.push(() => { gate.release.resolve() })
    const handle = await ctx.agents.create({ sessionId: childId, parentAgent: parent,
      meta: { parentSession: parent.id, origin: 'subagent' }, agentOptions: { provider: 'failure-fixture', model: 'fixture' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hold this model request for cancellation.' }], source: { kind: 'user' } }))
    await gate.entered.promise
    handle.agent.inject(createUserMessage({ content: [{ type: 'text', text: 'Park this input before cancellation.' }], source: { kind: 'user' } }))
    let laterListeners = 0
    const stops = kind === 'session' ? [
      ctx.on('session/event', (session, event) => {
        if (session.id === childId && event.type === 'agent/inbox/spliced' && event.data.removedCount > 0) throw Object.create(null)
      }),
      ctx.on('session/event', (session, event) => {
        if (session.id === childId && event.type === 'agent/inbox/spliced' && event.data.removedCount > 0) laterListeners++
      }),
    ] : [
      ctx.on('agent/inbox/discarded', ({ agent }) => { if (agent.id === childId) throw Object.create(null) }),
      ctx.on('agent/inbox/discarded', ({ agent }) => { if (agent.id === childId) laterListeners++ }),
    ]
    releases.push(...stops)
    try {
      handle.agent.cancel({ kind: 'user' })
      assert.equal(laterListeners, 1)
      assert.equal(gate.signal.aborted, true)
      cancelObservers.push({ kind, aborted: gate.signal.aborted, laterListeners })
    } finally {
      for (const stop of stops) stop()
      gate.release.resolve()
      await handle.dispose()
    }
  }
  const fiber = [...ctx.loader.entries()].find(row => row.options.name === entry('jobs/jobs-local').href)?.fiber
  assert.ok(fiber)
  const stubborn = jobs.start({ kind: 'bash', label: 'teardown failure', run: () => ({ cancel() { throw Object.create(null) }, done: new Promise(() => {}) }) })
  const settled = []
  const stop = jobs.events.subscribe({ owners: 'all' }, event => {
    if (event.type === 'settled' && event.job.id === stubborn) settled.push(event.job.status)
  })
  releases.push(stop)
  await fiber.dispose()
  assert.deepEqual(settled, ['failed'])
  assert.equal(jobs.list(parent.id).length, 0)
  await parent.whenIdle()
  await ctx.sessions.flush(parent.session)
  const raw = await ctx.sessionPersistence.readRaw(parent.id)
  assert.ok(raw)
  const persisted = raw.content.trim().split('\n').map(line => JSON.parse(line))
    .filter(event => event.type === 'job/registered' || event.type === 'job/settled')
  const live = parent.session.snapshotEvents().filter(event => event.type === 'job/registered' || event.type === 'job/settled')
  assert.deepEqual(persisted, live)
  const registrations = persisted.filter(event => event.type === 'job/registered')
  assert.equal(registrations.length, 8)
  for (const registration of registrations) {
    const ends = persisted.filter(event => event.type === 'job/settled' && event.data.jobId === registration.data.jobId)
    assert.equal(ends.length, 1)
    assert.equal(registration.data.owner, parent.id)
    assert.equal(ends[0].data.producerReported, registration.data.label !== 'producer failure')
    assert.ok(registration.seq < ends[0].seq)
  }
  const bashRegistration = registrations.find(event => event.data.jobId === bash.value.jobId)
  assert.deepEqual(bashRegistration.data.toolCall, { callId: 'durable-bash', rootCallId: 'durable-bash' })
  const workflowRegistration = registrations.find(event => event.data.jobId === jobId)
  assert.deepEqual(workflowRegistration.data.toolCall, { callId: 'background-failure-workflow', rootCallId: 'background-failure-workflow' })
  process.stdout.write(`${JSON.stringify({ operation: 'background-failure-containment', statuses,
    childStatus: childOutcome.status, childDisposed, workflowDisposed, workflowRecordEnded: ended,
    workflowResultCollected: false, teardownStatus: settled[0], retainedRowsAfterTeardown: 0,
    durableLifecyclePairs: registrations.length, bashToolAttributed: true, physicalJsonlRoundTrip: true,
    publicationOrder: initialPublicationOrder, settlementWinsObserverAbort: true,
    startupFailure: failedStartState.detail, startupProducerReported: startupRecord.data.producerReported,
    archiveRunningChildren: archiveChildren.length, archiveSiblingStopsAfterFailure: true, cancelObservers,
    workflowCleanupRetried: workflowDisposals === 2, workflowStatus: workflow.status })}\n`)
} finally {
  for (const release of releases) await release()
  ctx.logger.warn = warn
  await ctx.fiber.dispose()
}
