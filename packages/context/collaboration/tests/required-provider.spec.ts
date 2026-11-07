/** Provider withdrawal retains the application's collaboration requirement. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import Collaboration, { collaborationOf, isCollaborationRequired } from '../src/index.ts'
import type { CollaborationAuthority, CollaborationSessionCreation } from '../src/index.ts'

class FixtureProvider extends Collaboration {
  capture(): CollaborationAuthority { throw new Error('this fixture has no authenticated request') }
  currentCreation(): CollaborationSessionCreation | undefined { return undefined }
  withSessionCreation<T>(_creation: CollaborationSessionCreation, operation: () => Promise<T>): Promise<T> { return operation() }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

it('allows an independent application without collaboration to keep owner semantics', () => {
  const ctx = new Context(); contexts.push(ctx)
  expect(collaborationOf(ctx)).toBeUndefined()
  expect(isCollaborationRequired(ctx)).toBe(false)
})

it('keeps execution-only application policy independent from collaboration', () => {
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('executionAuthorityRequired', true)
  expect(collaborationOf(ctx)).toBeUndefined()
  expect(isCollaborationRequired(ctx)).toBe(false)
})

it('refuses a managed application whose authorization provider is absent', () => {
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('collaborationRequired', true)
  expect(isCollaborationRequired(ctx)).toBe(true)
  expect(() => collaborationOf(ctx)).toThrow('required collaboration provider is unavailable')
})

it('retains required authorization across provider withdrawal and replacement', async () => {
  const ctx = new Context(); contexts.push(ctx)
  const first = await ctx.plugin(FixtureProvider)
  expect(collaborationOf(ctx)).toBeInstanceOf(FixtureProvider)
  await first.dispose()
  expect(isCollaborationRequired(ctx)).toBe(true)
  expect(() => collaborationOf(ctx)).toThrow('required collaboration provider is unavailable')
  const replacement = await ctx.plugin(FixtureProvider)
  expect(collaborationOf(ctx)).toBeInstanceOf(FixtureProvider)
  await replacement.dispose()
  expect(() => collaborationOf(ctx)).toThrow('required collaboration provider is unavailable')
})
