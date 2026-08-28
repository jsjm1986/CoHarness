// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelsSection } from '../src/client/ModelsSection.tsx'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import type { ProviderRow } from '../src/client/store.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'
import { settingsSchema } from './settings-schema.client.ts'

afterEach(cleanup)

function row(provider: string, management: 'personal' | 'project'): ProviderRow {
  return {
    entry: {
      provider,
      displayName: provider === 'project-relay' ? 'Project relay' : 'Personal relay',
      settingsNs: 'project-models',
      settingsPath: ['providers', provider],
      active: true,
      management,
      declared: true,
    },
    configured: true,
    removable: true,
    apiKeyEnv: undefined,
    credential: undefined,
    models: [],
    catalogFailure: undefined,
  }
}

function ready(controller: ModelsSettingsStore, provider: string, management: 'personal' | 'project'): void {
  controller.store.set({
    status: 'ready',
    error: null,
    credentialError: null,
    writable: true,
    rows: [row(provider, management)],
    namespaces: new Map([['project-models', {
      ns: 'project-models', schema: {}, value: { providers: {} }, user: { providers: {} },
      applies: 'live', secrets: [], revision: 1,
    }]]),
  })
}

function props(overrides: Partial<ModelsSectionProps> = {}): ModelsSectionProps {
  const personal = new ModelsSettingsStore({} as never, {} as never, {} as never)
  ready(personal, 'personal-relay', 'personal')
  return {
    controller: personal,
    useSnapshot: (() => personal.store.getSnapshot()) as never,
    api: {} as never,
    schema: settingsSchema,
    t: key => en[key],
    ...overrides,
  }
}

describe('ModelsSection project scope', () => {
  it('renders the project controller rather than the personal controller', () => {
    const project = new ModelsSettingsStore({} as never, {} as never, {} as never)
    ready(project, 'project-relay', 'project')
    render(<ModelsSection {...props({
      settingsScope: 'project',
      projectId: 7,
      projectBinding: () => ({ controller: project, api: {} as never }),
    })} />)
    expect(screen.getByText('Project relay')).toBeTruthy()
    expect(screen.queryByText('Personal relay')).toBeNull()
  })

  it('explains an unavailable project binding without falling back to personal settings', () => {
    render(<ModelsSection {...props({ settingsScope: 'project', projectId: 7 })} />)
    expect(screen.getByText(en.projectUnavailable)).toBeTruthy()
    expect(screen.queryByText('Personal relay')).toBeNull()
  })
})
