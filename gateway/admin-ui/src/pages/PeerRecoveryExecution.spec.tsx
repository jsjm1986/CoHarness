/** Recovery review keeps exact permissions and operator input separate from passive status refresh. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { translateCopy } from '../language.ts'
import { PeerRecoveryExecution, recoveryExecutionMessage } from './PeerRecoveryExecution.tsx'
import { zh, en } from './peer-backup.copy.ts'

const t = translateCopy('en', { zh, en })
const message = (code: string) => recoveryExecutionMessage(code, t) ?? code
const plugin = { id: 'private-worker', kind: 'plugin', name: 'Private worker', itemDigest: 'a'.repeat(64),
  artifactSha256: 'b'.repeat(64), configurationSha256: 'c'.repeat(64), status: 'suspended', reason: 'recovery-startup-proof-required' }
const connection = { ...plugin, id: 'external-tool', kind: 'external-connection', name: 'External tool', status: 'eligible', reason: undefined }
const initial = () => ({ recoveryMode: 'disaster', phase: 'published', runtimeId: 'runtime', pointId: 'point',
  targetNodeId: 'replacement', targetEpoch: '2', reviewRevision: null as string | null, status: 'unprepared',
  preparationStatus: 'idle', errorCode: null, oldSessionCount: null as number | null, tasksSuspended: true,
  sessionsReadOnly: true, items: [plugin, connection], blockers: [] as string[] })
type Request = Parameters<typeof PeerRecoveryExecution>[0]['request']
afterEach(cleanup)

it('retains target configuration guidance when a personal recovery is reviewed directly on the local computer', async () => {
  const request: Request = async <T,>(): Promise<T> => ({ ...initial(),
    suspendedEnvironmentKeys: ['HGW_DATABASE_URL', 'PGPASSWORD'] }) as T
  render(<PeerRecoveryExecution operationId="recovery" scopeKind="personal" request={request} t={t} message={message} />)
  await screen.findByText('Suspended connection and environment settings (2)')
  expect(screen.getByText('HGW_DATABASE_URL')).toBeTruthy()
  expect(screen.getByText('PGPASSWORD')).toBeTruthy()
  expect(screen.getByText(t('suspendedEnvironmentExplanation'))).toBeTruthy()
})

it('explains that a missing immutable permission file must be restored before inspection and displays the failure once', async () => {
  const request: Request = async <T,>(): Promise<T> => ({ ...initial(), preparationStatus: 'failed',
    errorCode: 'peer-backup/execution-policy-missing', blockers: ['peer-backup/execution-policy-missing'] }) as T
  render(<PeerRecoveryExecution operationId="recovery" request={request} t={t} message={message} />)
  await screen.findByText(t('executionPolicyMissing'))
  expect(screen.getAllByText(t('executionPolicyMissing'))).toHaveLength(1)
  expect(screen.queryByRole('button', { name: t('executionReviewEnable') })).toBeNull()
})

it.each(['project', 'personal'] as const)('prepares %s permission and enables only new conversations while unsupported plugins remain disabled', async scopeKind => {
  const base = scopeKind === 'personal' ? '/personal-recoveries/' : '/recoveries/'
  let state = initial()
  const writes: Array<{ path: string; body: unknown }> = []
  const request: Request = async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (method === 'POST') {
      writes.push({ path, body })
      state = path.endsWith('/prepare') ? { ...state, preparationStatus: 'queued' }
        : { ...state, status: 'new-conversations-enabled' }
    }
    return state as T
  }
  render(<PeerRecoveryExecution operationId="recovery" scopeKind={scopeKind} request={request} t={t} message={message} />)
  fireEvent.click(await screen.findByRole('button', { name: t('executionPrepare') }))
  await screen.findByText(t('executionPreparing'))
  expect(writes).toEqual([{ path: base + 'recovery/execution/prepare', body: { confirm: 'recovery' } }])
  expect(screen.queryByRole('button', { name: t('executionReviewEnable') })).toBeNull()
  state = { ...state, preparationStatus: 'ready', status: 'review-required', reviewRevision: 'review-1', oldSessionCount: 3,
    items: [...state.items, { ...plugin, id: 'hook-file', name: 'Hook command', reason: 'hook-source-unavailable' }] }
  fireEvent.click(screen.getByRole('button', { name: t('executionRefresh') }))
  fireEvent.click(await screen.findByRole('button', { name: t('executionReviewEnable') }))
  const enable = screen.getByRole('button', { name: t('executionEnable') })
  expect(enable.hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: t('executionEnableAcknowledgement') }))
  fireEvent.click(enable)
  await screen.findByText(t('executionNewConversationsEnabled'))
  expect(writes[1]).toEqual({ path: base + 'recovery/execution/enable',
    body: { confirm: 'recovery', reviewRevision: 'review-1', mode: 'new-conversations-only' } })
  expect(screen.getByText(t('executionHistoryReadOnly', { count: '3' }))).toBeTruthy()
  expect(screen.getByText(t('executionOldWorkSuspended'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: t('executionReviewItem', { name: plugin.name }) })).toBeNull()
  expect(screen.getByText(t('executionProofRequired'))).toBeTruthy()
  expect(screen.getByText(t('executionHookSourceUnavailable'))).toBeTruthy()
  expect(screen.queryByRole('button', { name: t('executionReviewItem', { name: 'Hook command' }) })).toBeNull()
})

it('retains item evidence after a stale approval and requires the newly inspected revision and item digest', async () => {
  let state = { ...initial(), preparationStatus: 'ready', status: 'new-conversations-enabled', reviewRevision: 'review-1', oldSessionCount: 3 }
  let stale = true
  const writes: unknown[] = []
  const request: Request = async <T,>(_path: string, method = 'GET', body?: unknown): Promise<T> => {
    if (method === 'POST') {
      writes.push(body)
      if (stale) throw new Error('peer-backup/execution-review-changed')
      state = { ...state, reviewRevision: 'review-3', items: [plugin, { ...connection, status: 'approved' }] }
    }
    return state as T
  }
  render(<PeerRecoveryExecution operationId="recovery" request={request} t={t} message={message} />)
  fireEvent.click(await screen.findByRole('button', { name: t('executionReviewItem', { name: connection.name }) }))
  const evidence = screen.getByRole('textbox', { name: new RegExp(t('executionEvidence')) }) as HTMLInputElement
  fireEvent.change(evidence, { target: { value: 'review-ticket/42' } })
  fireEvent.click(screen.getByRole('checkbox', { name: t('executionItemAcknowledgement') }))
  fireEvent.click(screen.getByRole('button', { name: t('executionApproveItem') }))
  await screen.findByText(t('takeoverChanged'))
  expect(evidence.value).toBe('review-ticket/42')
  state = { ...state, reviewRevision: 'review-2' }
  fireEvent.click(screen.getByRole('button', { name: t('executionRefresh') }))
  await waitFor(() => expect(screen.getByRole('button', { name: t('executionApproveItem') }).hasAttribute('disabled')).toBe(true))
  fireEvent.click(screen.getByRole('button', { name: t('back') }))
  fireEvent.click(screen.getByRole('button', { name: t('executionReviewItem', { name: connection.name }) }))
  fireEvent.change(screen.getByRole('textbox', { name: new RegExp(t('executionEvidence')) }), { target: { value: 'review-ticket/43' } })
  fireEvent.click(screen.getByRole('checkbox', { name: t('executionItemAcknowledgement') }))
  stale = false
  fireEvent.click(screen.getByRole('button', { name: t('executionApproveItem') }))
  await screen.findByText(t('executionItemApproved'))
  expect(writes).toEqual([
    { confirm: 'recovery', reviewRevision: 'review-1', itemDigest: connection.itemDigest, evidenceReference: 'review-ticket/42' },
    { confirm: 'recovery', reviewRevision: 'review-2', itemDigest: connection.itemDigest, evidenceReference: 'review-ticket/43' },
  ])
})

it('does not replace another operation with a late review response', async () => {
  let finish!: (value: ReturnType<typeof initial>) => void
  let oldSignal: AbortSignal | undefined
  const held = new Promise<ReturnType<typeof initial>>(resolve => { finish = resolve })
  const request: Request = async <T,>(path: string, _method?: string, _body?: unknown, signal?: AbortSignal): Promise<T> => {
    if (path.includes('/old/')) { oldSignal = signal; return await held as T }
    return { ...initial(), status: 'new-conversations-enabled', oldSessionCount: 5 } as T
  }
  const view = render(<PeerRecoveryExecution key="old" operationId="old" request={request} t={t} message={message} />)
  view.rerender(<PeerRecoveryExecution key="new" operationId="new" request={request} t={t} message={message} />)
  await screen.findByText(t('executionHistoryReadOnly', { count: '5' }))
  expect(oldSignal?.aborted).toBe(true)
  await act(async () => { finish({ ...initial(), oldSessionCount: 99 }); await held })
  expect(screen.queryByText(t('executionHistoryReadOnly', { count: '99' }))).toBeNull()
  expect(screen.getByText(t('executionHistoryReadOnly', { count: '5' }))).toBeTruthy()
})
