/** Recorded prompt changes and failed tool results through the assembled Trajectory inspector. */
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { expect, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import { clientSessionKey } from '@deepseek-ai/dsh-host-apiproxy/api'
import { launchWebScaffold, seedSession, watchConsole, captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { responsiveBrowser, responsiveBrowserName } from './responsive-browser.ts'
import { auditWorkflowState, newWorkflowPage } from './workflow-responsive-state.ts'
import { captureTextContrast, expectTextContrast } from './text-contrast.ts'
import { saveFailureShot } from './support.ts'

const BEFORE = 'TRAJECTORY_PROMPT_BEFORE'
const AFTER = 'TRAJECTORY_PROMPT_AFTER'
const BASH_FAILURE = 'TRAJECTORY_BASH_FAILURE: command exited with status 1'
const PROGRAM_FAILURE = 'TRAJECTORY_PROGRAM_FAILURE: recorded program rejected'
const DONE = 'TRAJECTORY_RECORD_STATES_DONE'

function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }]
}

/** Closed historical turns exercise rendering without executing the recorded failed commands. */
function recordedStates(): string {
  const session = Session.create(SessionId('trajectory-record-states-template'))
  let system: SessionSeq | undefined
  for (const turn of [1, 2]) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    const prompt = session.append('system/message', {
      turn, step: 1, message: createSystemMessage(`Shared prompt line\n${turn === 1 ? BEFORE : AFTER}`),
    }, system === undefined ? { surfaceOp: 'append' } : {
      surfaceOp: { op: 'replace', startSeq: system, endSeq: system }, sourceEventSeqs: [system],
    })
    system = prompt.seq
    session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
      reason: turn === 1 ? 'initial' : 'change',
    })
    session.append('user/message', createUserMessage({
      content: text(`Review recorded trajectory turn ${turn}.`), source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: text(`TRAJECTORY_CONTEXT_${turn}: fixture-owned context.`), source: { kind: 'fixture' },
    }), { surfaceOp: 'append' })
    const calls = turn === 1 ? [] : [
      { id: ToolCallId('trajectory-bash-failed'), name: 'bash',
        arguments: JSON.stringify({ command: 'false', description: 'Recorded failed shell command' }), result: BASH_FAILURE },
      { id: ToolCallId('trajectory-program-failed'), name: 'run_code',
        arguments: JSON.stringify({ code: 'throw new Error("recorded failure")', description: 'Recorded failed program' }), result: PROGRAM_FAILURE },
    ]
    session.append('assistant/message', {
      turn, step: 1, stream: [], message: createAssistantMessage({
        content: [...text(turn === 1 ? 'Initial recorded answer.' : DONE),
          ...calls.map(call => ({ type: 'tool-call' as const, id: call.id, name: call.name, arguments: call.arguments }))],
        source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      }),
    }, { surfaceOp: 'append' })
    for (const call of calls) {
      const source = session.append('tool/call', {
        turn, step: 1, callId: call.id, name: call.name, arguments: call.arguments,
      })
      session.append('tool/result', {
        turn, step: 1, message: createToolResultMessage({ callId: call.id, content: text(call.result), isError: true }),
      }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}',
    createdAt: Date.now() - 60_000, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
  ...session.snapshotEvents().map(event => JSON.stringify(event)), ''].join('\n')
}

it('opens recorded prompt differences and distinct failed tool outputs in the real inspector', async () => {
  const world = await launchWebScaffold()
  let browser: Browser | undefined
  let page: Page | undefined
  const failures: unknown[] = []
  try {
    const session = await seedSession(world, recordedStates(), 'trajectory-record-states')
    await (await world.ctx.workspaceRegistry.create(world.workspaceCwd)).attachSession(session)
    browser = await responsiveBrowser.launch()
    page = await newWorkflowPage(browser)
    const target = page
    const tripwire = watchConsole(target)
    await target.addInitScript((key) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: key })) },
      clientSessionKey({ kind: 'personal' }, session))
    await target.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await target.getByText('Review recorded trajectory turn 2.', { exact: true }).waitFor()
    await target.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    const pane = target.locator('[data-trajectory-scroll]')
    await pane.locator('[data-scroll-ready="true"]').waitFor()
    const details = target.locator('[data-trajectory-details]')
    const close = details.getByRole('button', { name: 'Close details', exact: true })
    const snapshots: string[] = []
    const inspect = async (state: string, surface: Locator, controls: readonly Locator[], check: () => Promise<void>) => {
      await check()
      await auditWorkflowState(target, 'trajectory-records', state, surface, controls, undefined, check)
      snapshots.push(`## ${state}\n${await captureStableAria(target,
        state === 'visible-record-kinds' ? '[data-trajectory-scroll]' : '[data-trajectory-details]', world.workspaceCwd)}`)
    }
    const open = async (record: Locator) => {
      const action = await target.locator('[data-trajectory-feed]').count() > 0 ? record.getByRole('button').last() : record
      await action.click()
      await details.waitFor()
    }
    await inspect('visible-record-kinds', pane, [], async () => {
      const phone = await target.locator('[data-trajectory-feed]').count() > 0
      const readings = []
      for (const kind of ['system', 'context', 'user', 'message', 'tool']) {
        const record = pane.locator(`[data-record-index][data-kind="${kind}"]`).first()
        const label = record.locator(phone ? '[class*="kindLabel"]' : '[class*="kindTagLabel"]')
        const preview = record.locator('[class*="contentText"]').first()
        const visibleLabel = await label.isVisible()
        readings.push(...await captureTextContrast(target, [{ label: kind,
          text: visibleLabel ? label : preview.locator(':scope > span').first(),
          ...(visibleLabel ? {} : { region: preview }),
        }], `trajectory-kind-${kind}-${target.viewportSize()!.width}x${target.viewportSize()!.height}`))
      }
      expectTextContrast(readings)
    })
    const changedPrompt = pane.locator('[data-record-index][data-kind="system"]').nth(1)
    await open(changedPrompt)
    const diff = details.getByRole('tab', { name: 'Diff', exact: true })
    await diff.click()
    const removed = details.locator('[class*="promptDiffLineremoved"]').filter({ hasText: BEFORE })
    const added = details.locator('[class*="promptDiffLineadded"]').filter({ hasText: AFTER })
    await inspect('prompt-added-removed', details, [close, diff], async () => {
      expect(await removed.innerText()).toContain(`-${BEFORE}`)
      expect(await added.innerText()).toContain(`+${AFTER}`)
      expectTextContrast(await captureTextContrast(target, [
        { label: 'removed', text: removed }, { label: 'added', text: added },
      ], `trajectory-prompt-diff-${target.viewportSize()!.width}x${target.viewportSize()!.height}`))
    })
    await close.click()
    for (const [name, marker, selector] of [
      ['bash', BASH_FAILURE, '[class*="errorPayload"] pre'],
      ['run_code', PROGRAM_FAILURE, 'pre[class*="programError"]'],
    ] as const) {
      const record = pane.locator('[data-record-index][data-kind="tool"][data-error="true"]').filter({ hasText: name })
      expect(await record.count()).toBe(1)
      await open(record)
      await details.getByRole('tab', { name: 'Summary', exact: true }).click()
      await details.getByText('Failed', { exact: true }).waitFor()
      const result = details.getByRole('tab', { name: 'Result', exact: true })
      await result.click()
      const output = details.locator(selector).filter({ hasText: marker })
      await inspect(`${name}-failed-output`, details, [close, result], async () => {
        expect(await output.innerText()).toBe(marker)
        expectTextContrast(await captureTextContrast(target, [{ label: `${name}-error`, text: output }],
          `trajectory-${name}-error-${target.viewportSize()!.width}x${target.viewportSize()!.height}`))
      })
      await close.click()
    }
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/frontend-responsiveness/trajectory-records.expected.md', import.meta.url)),
      snapshots.join('\n\n'), webSnapshotMode())
    expect(tripwire.pageErrors).toEqual([])
  } catch (error) {
    if (page !== undefined) await saveFailureShot(page, `trajectory-record-states-${responsiveBrowserName}`)
    failures.push(error)
  } finally {
    for (const close of [() => browser?.close(), () => world.close()]) {
      try { await close() } catch (error) { failures.push(error) }
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Trajectory record-state verification failed')
})
