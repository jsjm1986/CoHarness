// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleCreateOptions, ClientModuleLoaderTarget, DshWindow,
  WebBootEntry,
} from '@deepseek-ai/dsh-client-modules/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppWebEntry } from '../src/boot.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const PROVIDER_CLIENT_ID = 'provider/client'
const RUNTIME_CLIENT_ID = 'runtime/client'
const win = globalThis as DshWindow
const transportGlobal = globalThis as {
  __DSH_TRANSPORT__?: { loadBundle(url: string): Promise<void> }
}
const moduleFace = modulesClient as unknown as Record<string, unknown>

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete win.__DSH_BOOT__
  delete win.__ModuleLoader__
  delete transportGlobal.__DSH_TRANSPORT__
  document.body.innerHTML = ''
})

/** Install the stable facade shape that the Host injects before AppWebEntry runs. */
function installFacade(
  create?: (options: ClientModuleCreateOptions) => modulesClient.ClientModuleSystem,
): ClientModuleLoaderTarget {
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: create ?? (options => modulesClient.createClientModuleSystem(target, {
      id: MODULES_ID,
      exports: moduleFace,
    }, options)),
  }
  win.__ModuleLoader__ = target
  return target
}

async function expectBootFailure(setup: () => void, message: string): Promise<void> {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = document.createElement('div')
  document.body.append(container)
  setup()
  const entry = new AppWebEntry(container)
  await entry.run()
  expect(container.textContent).toContain(message)
  expect(error).toHaveBeenCalledOnce()
  await entry.dispose()
}

describe('bootstrap failure rendering', () => {
  it('leaves the loading page visible when a carrier owns fatal presentation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const entry = new AppWebEntry(container)
    const failure = vi.fn()
    await entry.run(failure)
    expect(failure).toHaveBeenCalledWith(new Error('web boot: window.__ModuleLoader__ bootstrap facade is missing'))
    expect(container.textContent).toContain('Loading plugins')
    expect(container.textContent).not.toContain('Failed to load plugins')
    expect(container.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
    await entry.dispose()
  })

  it.each([false, true])('routes failed plugin activation with carrier presentation=%s', async (carrier) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    win.__DSH_BOOT__ = {
      rev: 'graph',
      entries: [{ id: 'broken', url: '/broken.js', rev: '1' }],
      batches: [{ phase: 'application', url: '/application.js', rev: '1', entries: ['broken'] }],
    }
    const entry = new AppWebEntry(container, {
      loadBundle: async () => {
        target.load({ id: 'broken', factory: () => ({ apply() { throw new Error('plugin activation failed') } }) })
      },
    })
    const report = vi.fn<(reason: unknown) => void>()
    try {
      await entry.run(carrier ? report : undefined)
      if (carrier) {
        expect(report).toHaveBeenCalledOnce()
        expect(String(report.mock.calls[0]![0])).toContain('broken')
        expect(container.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
        expect(container.textContent).not.toContain('Failed to load plugins')
      } else {
        expect(report).not.toHaveBeenCalled()
        expect(container.textContent).toContain('Failed to load plugins')
        expect(container.textContent).toContain('broken')
      }
    } finally {
      await entry.dispose()
    }
  })

  it('renders a missing bootstrap facade', async () => {
    await expectBootFailure(
      () => { delete win.__ModuleLoader__ },
      'window.__ModuleLoader__ bootstrap facade is missing',
    )
  })

  it('renders a create failure owned by the facade', async () => {
    await expectBootFailure(() => {
      installFacade(() => { throw new Error('facade create failed') })
    }, 'facade create failed')
  })

  it('renders a malformed boot manifest', async () => {
    await expectBootFailure(() => {
      installFacade()
      delete win.__DSH_BOOT__
    }, 'window.__DSH_BOOT__ is missing or not an object')
  })

  it('renders a module-system construction failure', async () => {
    await expectBootFailure(() => {
      installFacade()
      const duplicate = { id: 'duplicate', url: '/duplicate/client.js', rev: '1' }
      win.__DSH_BOOT__ = {
        rev: 'graph',
        entries: [duplicate, duplicate],
        batches: [{ phase: 'application', url: '/batch.js', rev: 'batch', entries: ['duplicate'] }],
      }
    }, 'duplicate graph entry "duplicate"')
  })
})

describe('full workspace continuation', () => {
  it.each([
    { language: 'en', draft: 'Still editing', status: 'Open the full workspace to continue. Your draft stays here.' },
    { language: 'zh', draft: '未发送的文字', status: '请打开完整工作区继续。草稿保留在此页' },
    { language: 'en', draft: '', status: undefined },
  ])('keeps the full-index continuation separate from plugin failure ($language: $draft)', async ({ language, draft, status }) => {
    const nodeId = 'c06bdb76-ae4c-42db-80d8-9d5578ccf322', runtimeId = '346c1bc8-a9ac-4e59-a930-4551df414a17'
    const container = document.createElement('div'), marker = document.createElement('script')
    marker.id = 'dsh-runtime-bootstrap'
    marker.type = 'application/json'
    marker.textContent = JSON.stringify({ version: 1, principalId: 3, nodeId, runtimeId, nodeName: 'Compute', scope: 'personal', language })
    document.body.append(marker, container)
    const response = Promise.withResolvers<Response>()
    const fetchRemote = vi.fn(() => response.promise)
    const replace = vi.fn()
    vi.stubGlobal('fetch', fetchRemote)
    vi.stubGlobal('location', { origin: location.origin, replace })
    const ready = new Response(JSON.stringify({ kind: 'full-index', version: 1 }), {
      headers: { 'content-type': 'application/json', 'x-dsh-principal-id': '3' },
    })
    const entry = new AppWebEntry(container)
    const failure = vi.fn()
    const boot = entry.run(failure)
    const href = `${location.origin}/?dshRuntime=${runtimeId}&dshNode=${nodeId}&dshTarget=personal&dshBootstrap=full&dshPrincipal=3`
    try {
      const input = container.querySelector('textarea')!
      input.focus()
      input.value = draft
      input.dispatchEvent(new Event('input'))
      expect(container.querySelector('[data-dsh-boot-spinner]')).not.toBeNull()
      response.resolve(ready)
      await boot
      expect(failure).not.toHaveBeenCalled()
      expect(performance.getEntriesByType('mark').map(mark => mark.name)).toContain('dsh:boot:draft-attached')
      expect(container.textContent).not.toContain('Failed to load plugins')
      expect(container.querySelector('[data-dsh-boot-spinner]')).toBeNull()
      if (status === undefined) {
        expect(replace).toHaveBeenCalledExactlyOnceWith(new URL(href))
        expect(container.querySelector('textarea')).toBeNull()
      } else {
        expect(replace).not.toHaveBeenCalled()
        expect(container.querySelector('[role="status"]')?.textContent).toBe(status)
        expect(document.activeElement).toBe(input)
        expect(input.value).toBe(draft)
        expect(container.querySelector('a')?.href).toBe(href)
      }
    } finally {
      response.resolve(ready)
      await boot
      await entry.dispose()
    }
  })
})

describe('plugin activation', () => {
  it('prefetches a parser-loaded immediate row through the injected bundle transport', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'consumer', url: '/consumer.js', rev: '1' },
      {
        id: 'runtime',
        url: '/runtime.js',
        rev: '1',
        external: [PROVIDER_CLIENT_ID],
        immediately: true,
      },
      { id: 'provider', url: '/provider.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    const applicationUrl = '/application.js'
    win.__DSH_BOOT__ = {
      rev: 'graph',
      entries,
      batches: [{ phase: 'application', url: applicationUrl, rev: 'batch', entries: entries.map(row => row.id) }],
    }
    const loaded: string[] = []
    const registrations: ClientBundleRegistration[] = [
      {
        id: 'consumer',
        factory: require => ({
          apply: () => {
            expect((require(RUNTIME_CLIENT_ID) as { marker: string }).marker).toBe('provider')
          },
        }),
      },
      {
        id: 'provider',
        factory: () => ({ apply: () => {}, marker: 'provider' }),
      },
      {
        id: 'runtime',
        factory: require => ({
          apply: () => {},
          marker: (require(PROVIDER_CLIENT_ID) as { marker: string }).marker,
        }),
      },
      {
        id: 'renderer',
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', { mount: () => () => {} })
          },
        }),
      },
    ]
    transportGlobal.__DSH_TRANSPORT__ = {
      loadBundle: async (url) => {
        loaded.push(url)
        if (url !== applicationUrl) throw new Error(`missing fixture batch ${url}`)
        for (const registration of registrations) target.load(registration)
      },
    }

    const entry = new AppWebEntry(container)
    await entry.run()

    expect(loaded).toEqual([applicationUrl])
    await entry.dispose()
  })

  it('allows a modules-dependent row to be created before the modules row', async () => {
    const events: string[] = []
    const container = document.createElement('div')
    document.body.append(container)
    const target = installFacade()
    const entries: WebBootEntry[] = [
      { id: 'consumer', url: '/consumer.js', rev: '1' },
      { id: MODULES_ID, url: '/modules.js', rev: '1' },
      { id: 'renderer', url: '/renderer.js', rev: '1' },
    ]
    win.__DSH_BOOT__ = {
      rev: 'graph',
      entries,
      batches: [{
        phase: 'application',
        url: '/application.js',
        rev: 'batch',
        entries: entries.map(row => row.id),
      }],
    }
    const registrations = new Map<string, ClientBundleRegistration>([
      ['/consumer.js', {
        id: 'consumer',
        factory: () => ({
          inject: ['modules'],
          apply: (ctx: Context) => {
            expect(ctx.modules).toBeDefined()
            events.push('consumer')
          },
        }),
      }],
      ['/renderer.js', {
        id: 'renderer',
        factory: () => ({
          apply: (ctx: Context) => {
            ctx.reflect.provide('uiRenderer', {
              mount: (element: HTMLElement) => {
                events.push('mount')
                element.textContent = 'mounted'
                return () => {}
              },
            })
          },
        }),
      }],
    ])
    const entry = new AppWebEntry(container, {
      loadBundle: async (url) => {
        if (url !== '/application.js') throw new Error(`missing fixture batch ${url}`)
        for (const registration of registrations.values()) target.load(registration)
      },
    })

    await entry.run()

    expect(target.mode).toBe('live')
    expect(events).toEqual(['consumer', 'mount'])
    expect(container.textContent).toBe('mounted')
    const bootMarks = performance.getEntriesByType('mark').map(mark => mark.name).filter(name => name.startsWith('dsh:boot:'))
    expect(bootMarks.slice(-5)).toEqual([
      'dsh:boot:run-start',
      'dsh:boot:seed-ready',
      'dsh:boot:prefetch-ready',
      'dsh:boot:plugins-active',
      'dsh:boot:mounted',
    ])
    await entry.dispose()
  })
})

it('draws the shared boot page before Host injections and resumes without replacing the document', async () => {
  const gate = Promise.withResolvers<undefined>()
  vi.stubGlobal('__DSH_BOOT_READY__', gate)
  const container = document.createElement('div')
  document.body.append(container)
  const create = vi.fn(() => { throw new Error('injections consumed') })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const entry = new AppWebEntry(container)
  const boot = entry.run()
  try {
    const page = container.querySelector('[data-dsh-boot]')
    const spinner = container.querySelector('[data-dsh-boot-spinner]')
    expect(spinner).not.toBeNull()
    await Promise.resolve()
    expect(create).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    installFacade(create)
    gate.resolve(undefined)
    await boot
    expect(create).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-dsh-boot]')).toBe(page)
    expect(container.textContent).toContain('injections consumed')
  } finally {
    gate.resolve(undefined)
    await boot
    await entry.dispose()
    vi.unstubAllGlobals()
  }
})

it('completes boot when performance.mark throws and keeps retainAtMount idempotent', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const markSpy = vi.spyOn(performance, 'mark').mockImplementation(() => { throw new Error('telemetry disabled') })
  const { StartupDraftView } = await import('../src/startup-draft.ts')
  const draft = new StartupDraftView({
    principalId: 3, runtimeId: '11111111-1111-4111-8111-111111111111',
    nodeId: '22222222-2222-4222-8222-222222222222', nodeName: 'Compute', scope: 'personal', language: 'en',
  })
  const entry = new AppWebEntry(container)
  const create = vi.fn(() => { throw new Error('stop after start') })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    draft.attach(container)
    const input = container.querySelector('textarea')!
    input.value = 'keep me'
    input.dispatchEvent(new Event('input'))
    draft.retainAtMount()
    draft.retainAtMount()
    expect(document.body.querySelectorAll('details')).toHaveLength(1)

    installFacade(create)
    await entry.run()
    expect(create).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('stop after start')
  } finally {
    markSpy.mockRestore()
    error.mockRestore()
    draft.dispose()
    await entry.dispose()
  }
})
