import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPolicy } from '../src/policy.ts'

function policy(provider: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 2,
    defaultAllowed: false,
    userDeclaredAllowed: false,
    models: [{ provider: 'project-42-relay', model: 'chat', allowed: true }],
    providers: [provider],
    intakeUrl: 'http://127.0.0.1:1/usage',
    intakeToken: 'token',
  }
}

function read(provider: Record<string, unknown>): ReturnType<typeof loadPolicy> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-project-policy-'))
  const path = join(home, 'model-governance.json')
  writeFileSync(path, JSON.stringify(policy(provider)))
  return loadPolicy(path)
}

describe('project model policy', () => {
  it('accepts project-scoped routes and preserves their ownership metadata', () => {
    const loaded = read({
      provider: 'project-42-relay',
      scope: 'project',
      projectId: 42,
      displayName: 'Project relay',
      driver: 'pi-ai',
      protocol: 'anthropic-messages',
      baseURL: 'https://relay.example/v1',
      credentialRef: 'DSH_PROJECT_42_RELAY_API_KEY',
      models: [{ id: 'chat', name: 'Chat' }],
    })
    expect(loaded.providers[0]).toMatchObject({ scope: 'project', projectId: 42 })
  })

  it('rejects a project route whose id or credential belongs to another project', () => {
    expect(() => read({
      provider: 'project-42-relay', scope: 'project', projectId: 7,
      displayName: 'Project relay', driver: 'pi-ai', protocol: 'openai-responses',
      baseURL: 'https://relay.example/v1', credentialRef: 'DSH_PROJECT_7_RELAY_API_KEY',
      models: [{ id: 'chat', name: 'Chat' }],
    })).toThrow(/does not belong to project/)
  })

  it('rejects a project credential reference whose project id does not match the route', () => {
    expect(() => read({
      provider: 'project-42-relay', scope: 'project', projectId: 42,
      displayName: 'Project relay', driver: 'pi-ai', protocol: 'openai-responses',
      baseURL: 'https://relay.example/v1', credentialRef: 'DSH_PROJECT_7_RELAY_API_KEY',
      models: [{ id: 'chat', name: 'Chat' }],
    })).toThrow(/credentialRef does not belong to project/)
  })

  it('rejects project-looking credentials on organization routes', () => {
    expect(() => read({
      provider: 'org-relay', displayName: 'Organization relay', driver: 'pi-ai',
      protocol: 'openai-responses', baseURL: 'https://relay.example/v1',
      credentialRef: 'DSH_PROJECT_42_RELAY_API_KEY', models: [{ id: 'chat', name: 'Chat' }],
    })).toThrow(/must not use a project credential reference/)
  })

  it('treats a legacy organization route without scope metadata as organization-owned', () => {
    const loaded = read({
      provider: 'org-legacy', displayName: 'Legacy organization relay', driver: 'pi-ai',
      protocol: 'openai-responses', baseURL: 'https://relay.example/v1',
      models: [{ id: 'chat', name: 'Chat' }],
    })
    expect(loaded.providers[0]).not.toHaveProperty('scope')
    expect(loaded.providers[0]).not.toHaveProperty('projectId')
  })
})
