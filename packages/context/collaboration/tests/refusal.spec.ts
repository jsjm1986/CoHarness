/** Collaboration failures retain one transport-safe refusal vocabulary. */
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it } from 'vitest'
import { CollaborationError, collaborationRefusal, collaborationRemoteRefusal } from '../src/index.ts'

it.each([
  ['conversation-not-found', 'Conversation is unavailable.'],
  ['not-member', 'You are not a member of this project.'],
  ['visibility-locked', 'Conversation visibility cannot be changed after another participant contributes.'],
  ['gateway-unavailable', 'Collaboration authorization is temporarily unavailable.'],
  ['forbidden', 'You do not have permission to perform this action.'],
] as const)('exposes a stable %s refusal without leaking provider diagnostics', (reason, message) => {
  const error = new CollaborationError(reason, 'private backend diagnostic')
  expect(collaborationRefusal(error, 'write')).toEqual({
    code: 'collaboration-forbidden', message, details: { action: 'write', reason },
  })
})

it('maps an unknown backend failure to unavailability and preserves the addressed session', () => {
  const refusal = collaborationRefusal(new Error('private transport diagnostic'), 'read', SessionId('shared-root'))
  expect(refusal).toEqual({
    code: 'collaboration-forbidden',
    message: 'Collaboration authorization is temporarily unavailable.',
    details: { action: 'read', reason: 'gateway-unavailable', sessionId: 'shared-root' },
  })
})

it('preserves the RPC refusal code and details in the Typert error', () => {
  const cause = new CollaborationError('not-member')
  const error = collaborationRemoteRefusal(cause, 'approve', SessionId('shared-root'))
  const refusal = collaborationRefusal(cause, 'approve', SessionId('shared-root'))
  expect(error).toBeInstanceOf(RemoteError)
  expect(error).toMatchObject({ code: refusal.code, message: refusal.message, details: refusal.details, cause })
})
