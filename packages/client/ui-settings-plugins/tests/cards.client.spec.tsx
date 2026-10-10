// @vitest-environment jsdom
/**
 * What the Plugins page's configuration entries show: a one-liner for
 * `view: 'summary'`, nothing while the namespace is unavailable, and the page
 * form whose save footer decides when staged edits are written.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentLoopCard } from '../src/client/AgentLoopCard.tsx'
import type { AgentLoopCardProps } from '../src/client/AgentLoopCard.tsx'
import { BashCard } from '../src/client/BashCard.tsx'
import type { BashCardProps } from '../src/client/BashCard.tsx'
import { WebSearchCard } from '../src/client/WebSearchCard.tsx'
import { SubagentModelSelectionCard, type SubagentModelSelectionCardProps } from '../src/client/SubagentModelSelectionCard.tsx'
import type { SubagentModelSelectionCardState } from '../src/client/subagent-model-selection-card-controller.ts'
import { SubagentLimitsCard } from '../src/client/SubagentLimitsCard.tsx'
import type { SubagentLimitsCardProps } from '../src/client/SubagentLimitsCard.tsx'
import type { SubagentLimitsCardState } from '../src/client/subagent-limits-card-controller.ts'
import type { WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import { PluginForm } from '../src/client/PluginForm.tsx'
import type { AgentLoopCardState } from '../src/client/agent-loop-card-controller.ts'
import type { BashCardState } from '../src/client/bash-card-controller.ts'
import type { CardFieldState, CardShell } from '../src/client/card-form.ts'
import type { WebSearchCardState } from '../src/client/web-search-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

// `TranslateNS` accepts the namespace's merged key set; the fixture needs only this package's dictionary.
const t = (key: string) => (en as Record<string, string>)[key] ?? key

/** The global seat a `plugins.item` entry receives; the card bodies under test never read it. */
const unusedGlobalHook = (): never => { throw new Error('card fixture provides no global state') }
const globalStandard = { useSessions: unusedGlobalHook, useWorkspaces: unusedGlobalHook, usePanelInfo: unusedGlobalHook }

/** A settled form: nothing staged, everything served. */
const settled: CardShell = {
  available: true,
  writable: true,
  dirty: false,
  invalid: false,
  saving: false,
  failed: false,
}

describe('Subagent limits card', () => {
  it('shows upstream delegation rules, validates depth, and respects read-only ownership', () => {
    const state: SubagentLimitsCardState = {
      ...settled, maxDepth: field('1'), maxActiveSubagents: field('8'),
    }
    const actions = cardActions()
    const props: SubagentLimitsCardProps = {
      ...globalStandard, t, ...actions, view: 'page', useSubagentLimitsCard: bindSnapshotSelector(createSnapshotStore(state)),
    }
    const { rerender } = render(<SubagentLimitsCard {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.subagentDepthHelpLabel }))
    const depth = screen.getByLabelText(en.subagentMaxDepth)
    const help = screen.getByRole('region', { name: en.subagentDepthHelpLabel })
    expect(depth.getAttribute('aria-describedby')).toContain(help.id)
    expect(screen.getByText(en.subagentDepthZero)).toBeTruthy()
    fireEvent.change(depth, { target: { value: '0' } })
    expect(actions.edit).toHaveBeenCalledWith('maxDepth', '0')
    fireEvent.click(screen.getByRole('button', { name: en.subagentDepthHelpLabel }))
    expect(screen.queryByRole('region', { name: en.subagentDepthHelpLabel })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.subagentCapacityHelpLabel }))
    expect(screen.getByText(en.subagentCapacityHelp)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(en.subagentMaxActive), { target: { value: '12' } })
    expect(actions.edit).toHaveBeenCalledWith('maxActiveSubagents', '12')
    rerender(<SubagentLimitsCard {...props} useSubagentLimitsCard={bindSnapshotSelector(createSnapshotStore({
      ...state, maxDepth: { ...field('3'), overridden: true }, maxActiveSubagents: { ...field('12'), overridden: true },
    }))} />)
    for (const button of screen.getAllByRole('button', { name: en.reset })) fireEvent.click(button)
    expect(actions.resetField.mock.calls).toEqual([['maxDepth'], ['maxActiveSubagents']])
    rerender(<SubagentLimitsCard {...props} useSubagentLimitsCard={bindSnapshotSelector(createSnapshotStore({
      ...state, writable: false, writableReason: 'project' as const,
      maxDepth: { ...field('invalid'), invalid: true, overridden: true },
      maxActiveSubagents: { ...field('8'), overridden: true },
    }))} />)
    expect(screen.getByLabelText(en.subagentMaxDepth)).toHaveProperty('disabled', true)
    expect(screen.getByText(en.readOnlyProject)).toBeTruthy()
    expect(screen.getByText(en.subagentDepthInvalid)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en.reset }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  })

  it('renders nothing while its namespace is unavailable, and answers only its one-liner for a summary', () => {
    const fields = { maxDepth: field('1'), maxActiveSubagents: field('8') }
    const props: SubagentLimitsCardProps = {
      ...globalStandard, ...cardActions(), t, view: 'page',
      useSubagentLimitsCard: bindSnapshotSelector(createSnapshotStore<SubagentLimitsCardState>({
        ...settled, available: false, ...fields,
      })),
    }
    const { container } = render(<div />)
    render(<SubagentLimitsCard {...props} />)
    expect(container.textContent).toBe('')
    expect(screen.queryByLabelText(en.subagentMaxDepth)).toBeNull()

    cleanup()
    render(<SubagentLimitsCard {...props} view="summary" useSubagentLimitsCard={bindSnapshotSelector(createSnapshotStore<SubagentLimitsCardState>({ ...settled, ...fields }))} />)
    expect(screen.getByText(en.subagentDescription)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
  })
})

/** One control's state, defaulting to an inherited value. */
function field(text: string, rest: Partial<CardFieldState> = {}): CardFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

function renderBash(state: Partial<BashCardState> = {}, view: 'summary' | 'page' = 'page') {
  const store = createSnapshotStore<BashCardState>({
    ...settled,
    timeoutMs: field('60000'),
    maxOutputBytes: field('64000'),
    ...state,
  })
  const actions = cardActions()
  const props: BashCardProps = { ...globalStandard, ...actions, t, view, useBashCard: bindSnapshotSelector(store) }
  render(<BashCard {...props} />)
  return actions
}

describe('BashCard', () => {
  it('renders nothing while its namespace is unavailable', () => {
    const { container } = render(<div />)
    renderBash({ available: false })

    expect(container.textContent).toBe('')
    expect(screen.queryByText(en.bashTitle)).toBeNull()
  })

  it('answers only its one-liner when the page asks for a summary', () => {
    renderBash({}, 'summary')

    expect(screen.getByText(en.bashDescription)).toBeTruthy()
    expect(screen.queryByLabelText(en.bashTimeoutMs)).toBeNull()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
  })

  it('stages an edit instead of writing it', () => {
    const actions = renderBash()

    fireEvent.change(screen.getByLabelText(en.bashTimeoutMs), { target: { value: '9000' } })

    expect(actions.edit).toHaveBeenCalledWith('timeoutMs', '9000')
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('offers the reset for an overridden field only', () => {
    const actions = renderBash({ timeoutMs: field('9000', { overridden: true }) })

    // One badge and one reset: the output cap is still inherited.
    expect(screen.getAllByText(en.overridden)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('timeoutMs')
  })

  it('addresses each of its two fields separately', () => {
    const actions = renderBash({ maxOutputBytes: field('64000', { overridden: true }) })

    fireEvent.change(screen.getByLabelText(en.bashMaxOutputBytes), { target: { value: '1024' } })
    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.edit).toHaveBeenCalledWith('maxOutputBytes', '1024')
    expect(actions.resetField).toHaveBeenCalledWith('maxOutputBytes')
  })

  it('keeps save and discard inert until something is staged', () => {
    renderBash()

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
    expect(screen.queryByText(en.unsaved)).toBeNull()
  })

  it('writes the staged edits when saved, and drops them when discarded', () => {
    const actions = renderBash({ dirty: true, timeoutMs: field('9000', { overridden: true }) })

    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.discard }))

    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('marks a form holding unsaved edits', () => {
    renderBash({ dirty: true })

    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('blocks the save while a draft is invalid, and says why', () => {
    renderBash({ dirty: true, invalid: true, timeoutMs: field('soon', { invalid: true }) })

    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', false)
    expect(screen.getByText(en.invalidNumber)).toBeTruthy()
  })

  it('reports a save in flight and refuses another', () => {
    renderBash({ dirty: true, saving: true })

    expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
  })

  it('reports a save the deployment did not accept', () => {
    renderBash({ dirty: true, failed: true })

    expect(screen.getByText(en.saveFailed)).toBeTruthy()
  })

  it('says the document is read-only and disables its controls', () => {
    renderBash({ writable: false })

    expect(screen.getByRole('status')).toHaveProperty('textContent', en.readOnly)
    expect(screen.getByLabelText(en.bashTimeoutMs)).toHaveProperty('disabled', true)
  })
})

describe('AgentLoopCard', () => {
  it('stages and saves the only field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      dirty: true,
      maxParallelToolCalls: field('10'),
    })
    const actions = cardActions()
    const props: AgentLoopCardProps = {
      ...globalStandard,
      ...actions,
      t,
      view: 'page',
      useAgentLoopCard: bindSnapshotSelector(store),
    }
    render(<AgentLoopCard {...props} />)

    fireEvent.change(screen.getByLabelText(en.agentLoopMaxParallel), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(actions.edit).toHaveBeenCalledWith('maxParallelToolCalls', '2')
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('stages a reset for the field it owns', () => {
    const store = createSnapshotStore<AgentLoopCardState>({
      ...settled,
      maxParallelToolCalls: field('2', { overridden: true }),
    })
    const actions = cardActions()
    const props: AgentLoopCardProps = {
      ...globalStandard,
      ...actions,
      t,
      view: 'page',
      useAgentLoopCard: bindSnapshotSelector(store),
    }
    render(<AgentLoopCard {...props} />)

    fireEvent.click(screen.getByRole('button', { name: en.reset }))

    expect(actions.resetField).toHaveBeenCalledWith('maxParallelToolCalls')
  })

  it('renders nothing while its namespace is unavailable, and answers only its one-liner for a summary', () => {
    const store = createSnapshotStore<AgentLoopCardState>({ ...settled, available: false, maxParallelToolCalls: field('10') })
    const props: AgentLoopCardProps = { ...globalStandard, ...cardActions(), t, view: 'page', useAgentLoopCard: bindSnapshotSelector(store) }
    const { container } = render(<div />)
    render(<AgentLoopCard {...props} />)
    expect(container.textContent).toBe('')
    expect(screen.queryByLabelText(en.agentLoopMaxParallel)).toBeNull()

    cleanup()
    render(<AgentLoopCard {...props} view="summary" useAgentLoopCard={bindSnapshotSelector(createSnapshotStore({ ...settled, maxParallelToolCalls: field('10') }))} />)
    expect(screen.getByText(en.agentLoopDescription)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
  })
})

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}, view: 'summary' | 'page' = 'page') {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled,
      baseURL: field(''),
      maxUses: field('5'),
      apiKey: field(''),
      apiKeyConfigured: false,
      apiKeyWritable: true,
      ...state,
    })
    const actions = cardActions()
    const props: WebSearchCardProps = { ...globalStandard, ...actions, t, view, useWebSearchCard: bindSnapshotSelector(store) }
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('renders nothing while its namespace is unavailable, and answers only its one-liner for a summary', () => {
    const { container } = render(<div />)
    renderWebSearch({ available: false })
    expect(container.textContent).toBe('')
    expect(screen.queryByLabelText(en.webSearchBaseUrl)).toBeNull()

    cleanup()
    renderWebSearch({}, 'summary')
    expect(screen.getByText(en.webSearchDescription)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
  })

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })

    expect(screen.getByText(en.webSearchApiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })

    const key = screen.getByLabelText(en.webSearchApiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'ds-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderWebSearch({ apiKeyConfigured: true, apiKeyWritable: false })

    expect(screen.getByLabelText(en.webSearchApiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.webSearchBaseUrl)).toHaveProperty('disabled', false)
  })

  it('stages the endpoint, the search budget, and their resets', () => {
    const actions = renderWebSearch({
      baseURL: field('https://search.test/v1', { overridden: true }),
      maxUses: field('3', { overridden: true }),
    })

    fireEvent.change(screen.getByLabelText(en.webSearchBaseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.webSearchMaxUses), { target: { value: '4' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(2)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['baseURL', 'https://other.test'],
      ['maxUses', '4'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['baseURL'], ['maxUses']])
  })
})

describe('Subagent model selection card', () => {
  it('renders catalog failures, unavailable saved routes and revision conflicts', () => {
    const store = createSnapshotStore<SubagentModelSelectionCardState>({
      ...settled, enabled: true, catalogStatus: 'error', catalogPartial: true, conflicted: true, invalid: true,
      candidates: [
        { key: 'a/one', provider: 'a', providerName: 'Alpha', model: 'one', modelName: 'One', available: true, selected: true },
        { key: 'a/two', provider: 'a', providerName: 'Alpha', model: 'two', modelName: 'Two', available: true, selected: false },
        { key: 'b/gone', provider: 'b', providerName: 'Beta', model: 'gone', modelName: 'Gone', available: false, selected: true },
      ],
    })
    const toggleModel = vi.fn()
    const toggleEnabled = vi.fn()
    const retryCatalog = vi.fn()
    const props: SubagentModelSelectionCardProps = { ...globalStandard, t, view: 'page', useSubagentModelSelectionCard: bindSnapshotSelector(store),
      toggleModel, toggleEnabled, retryCatalog, save: vi.fn(), discard: vi.fn() }
    const { rerender } = render(<SubagentModelSelectionCard {...props} />)
    expect(screen.getByText(en.subagentModelSelectionConflict)).toBeTruthy()
    expect(screen.getByText(en.subagentModelSelectionPartial)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retryCatalog).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('checkbox', { name: /Two/ }))
    expect(toggleModel).toHaveBeenCalledWith('a/two')
    fireEvent.click(screen.getByRole('switch'))
    expect(toggleEnabled).toHaveBeenCalledOnce()
    store.set({ ...store.getSnapshot(), candidates: store.getSnapshot().candidates.filter(candidate => candidate.available) })
    rerender(<SubagentModelSelectionCard {...props} />)
    expect(screen.queryByText(en.subagentModelSelectionUnavailableGroup)).toBeNull()
    for (const catalogStatus of ['loading', 'ready', 'idle'] as const) {
      store.set({ ...store.getSnapshot(), candidates: [], catalogStatus, catalogPartial: false, conflicted: false, invalid: false })
      rerender(<SubagentModelSelectionCard {...props} />)
      if (catalogStatus === 'ready') expect(screen.getByText(en.subagentModelSelectionEmpty)).toBeTruthy()
    }
    store.set({ ...store.getSnapshot(), enabled: false, writable: false, writableReason: 'deployment' })
    rerender(<SubagentModelSelectionCard {...props} />)
    expect(screen.getByText(en.subagentModelSelectionOff)).toBeTruthy()
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true)
  })

  it('renders nothing while its namespace is unavailable, and answers only its one-liner for a summary', () => {
    const idle: SubagentModelSelectionCardState = { ...settled, enabled: true, catalogStatus: 'idle', catalogPartial: false, conflicted: false, candidates: [] }
    const props: SubagentModelSelectionCardProps = { ...globalStandard, t, view: 'page',
      useSubagentModelSelectionCard: bindSnapshotSelector(createSnapshotStore({ ...idle, available: false })),
      toggleModel: vi.fn(), toggleEnabled: vi.fn(), retryCatalog: vi.fn(), save: vi.fn(), discard: vi.fn() }
    const { container } = render(<div />)
    render(<SubagentModelSelectionCard {...props} />)
    expect(container.textContent).toBe('')
    expect(screen.queryByRole('switch')).toBeNull()

    cleanup()
    render(<SubagentModelSelectionCard {...props} view="summary" useSubagentModelSelectionCard={bindSnapshotSelector(createSnapshotStore(idle))} />)
    expect(screen.getByText(en.subagentModelSelectionToggle)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.save })).toBeNull()
  })
})

describe('PluginForm', () => {
  it('renders nothing while its namespace is unavailable', () => {
    const { container } = render(
      <PluginForm t={t} state={{ ...settled, available: false }} onSave={vi.fn()} onDiscard={vi.fn()}>
        <span>field</span>
      </PluginForm>,
    )
    expect(container.textContent).toBe('')
  })

  it('names the owner that keeps the settings read-only', () => {
    const reasons = [
      ['project', en.readOnlyProject],
      ['account', en.readOnlyAccount],
      ['organization', en.readOnlyOrganization],
      ['deployment', en.readOnlyDeployment],
      [undefined, en.readOnly],
    ] as const
    const { rerender } = render(
      <PluginForm t={t} state={{ ...settled, writable: false, writableReason: 'project' }} onSave={vi.fn()} onDiscard={vi.fn()}>
        <span>field</span>
      </PluginForm>,
    )
    for (const [reason, text] of reasons) {
      rerender(
        <PluginForm t={t}
          state={{ ...settled, writable: false, ...(reason === undefined ? {} : { writableReason: reason }) }}
          onSave={vi.fn()} onDiscard={vi.fn()}>
          <span>field</span>
        </PluginForm>,
      )
      expect(screen.getByText(text)).toBeTruthy()
    }
  })
})
