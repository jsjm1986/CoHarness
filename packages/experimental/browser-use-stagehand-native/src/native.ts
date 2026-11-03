/** Native Stagehand operations run inside one isolated browser Worker. */

import type { ClientLLM, Page, StagehandBrowser } from '@browserbasehq/stagehand'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { installedStagehandExtension } from './extension.ts'

/** Registered host model route used independently of the Session's main model. */
export interface StagehandModelConfig {
  /** Registered Harness provider; its normal credentials and authorization apply. */
  provider: string
  /** Exact model id exposed by that provider. */
  model: string
  /** Optional output cap; omission uses the registered provider's default. */
  maxTokens?: number
}

/** Explicit host model route; extension-owned credentials are rejected. */
export const stagehandModelSchema = z.object({
  provider: z.string().min(1).refine(value => value === value.trim(), 'Stagehand provider must have no surrounding whitespace'),
  model: z.string().min(1).refine(value => value === value.trim(), 'Stagehand model must have no surrounding whitespace'),
  maxTokens: z.number().int().positive().optional(),
}).strict().transform((route): StagehandModelConfig => ({
  provider: route.provider, model: route.model,
  ...route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens },
}))

/** Resolved browser options accepted by the native runtime and attachment worker. */
export interface NativeBrowserConfig {
  /** Non-secret host route; generation is delegated through the host callback. */
  model: StagehandModelConfig
  /** Whether the runtime owns Chromium or only its connection. */
  mode: 'launch' | 'attach'
  /** Existing browser's configured debugging endpoint. */
  cdpEndpoint?: string
  /** Optional existing Stagehand extension id. */
  extensionId?: string
  /** Executable selected for an owned Chromium instance. */
  executablePath?: string
  /** Whether to hide an owned browser's window. */
  headless: boolean
  /** Deadline for Chromium startup, navigation, and natural-language actions. */
  operationTimeoutMs: number
  /** Time allowed for attachment-worker shutdown before terminating it. */
  shutdownGraceMs: number
}

const pageArgs = { pageId: z.string().min(1).optional() }

/** Model and worker requests share the same validated browser arguments. */
export const browserInputs = {
  navigate: z.object({ ...pageArgs, url: z.url() }).strict(),
  tabs: z.discriminatedUnion('action', [
    z.object({ action: z.literal('list') }).strict(),
    z.object({ action: z.literal('new'), url: z.url().optional() }).strict(),
    z.object({ action: z.enum(['select', 'close']), pageId: z.string().min(1) }).strict(),
  ]),
  screenshot: z.object({ ...pageArgs, fullPage: z.boolean().default(false) }).strict(),
  act: z.object({ ...pageArgs, instruction: z.string().min(1) }).strict(),
  observe: z.object({ ...pageArgs, instruction: z.string().min(1) }).strict(),
  extract: z.object({ ...pageArgs, instruction: z.string().min(1), schema: z.record(z.string(), z.json()).optional() }).strict(),
}

/** Closed set of native browser operations. */
export type BrowserMethod = keyof typeof browserInputs

/** SDK requests did not drain before their connection Worker terminated. */
export class StagehandDrainError extends Error {}

/** Native browser operations and SDK cleanup owned by one live Session. */
export interface NativeBrowserRuntime {
  /**
   * Execute one operation after validating its tool or worker arguments.
   * @param method - supported browser operation.
   * @param args - untrusted JSON arguments.
   * @param signal - host-side cancellation; closes the Worker connection when supplied.
   * @returns a canonicalizable MCP result with text or screenshot content.
   */
  execute(method: BrowserMethod, args: unknown, signal?: AbortSignal): Promise<unknown>
  /** Release Stagehand state before Worker termination disconnects CDP. */
  close(): Promise<void>
}

/**
 * Open the pinned SDK using its public client-side model callback.
 * The host owns launched Chromium separately; this Worker owns only its CDP connection.
 * @param config - resolved profile-owned browser options.
 * @param model - validated callback that delegates each inference to its host owner.
 * @returns the native operation runtime after initialization completes.
 */
export async function openNativeBrowser(config: NativeBrowserConfig, model: ClientLLM): Promise<NativeBrowserRuntime> {
  const { Stagehand, localBrowser } = await import('@browserbasehq/stagehand')
  const endpoint = z.string().parse(config.cdpEndpoint)
  const extensionId = config.extensionId ?? await installedStagehandExtension(endpoint, config.operationTimeoutMs)
  const browser = await localBrowser.connect({
    cdpUrl: endpoint,
    ...extensionId === undefined ? {} : { extensionId },
  })
  const stagehand = await Stagehand.create({ browser, model, logging: { level: 'off' } })
  return {
    close: () => stagehand.close(),
    async execute(method, rawArgs) {
      switch (method) {
        case 'navigate': {
          const args = browserInputs.navigate.parse(rawArgs)
          const page = await selectPage(browser, args.pageId)
          await page.goto(args.url, { timeout: config.operationTimeoutMs })
          return textResult({ pageId: page.pageId, url: await page.url(), title: await page.title() })
        }
        case 'tabs': {
          const args = browserInputs.tabs.parse(rawArgs)
          const context = browser.context
          if (args.action === 'new') await context.newPage(args.url)
          if (args.action === 'select') await context.setActivePage(await selectPage(browser, args.pageId))
          if (args.action === 'close') await (await selectPage(browser, args.pageId)).close()
          const active = await context.activePage()
          return textResult({ tabs: await Promise.all((await context.pages()).map(async page => ({
            pageId: page.pageId, url: await page.url(), title: await page.title(), active: page.pageId === active?.pageId,
          }))) })
        }
        case 'screenshot': {
          const args = browserInputs.screenshot.parse(rawArgs)
          const page = await selectPage(browser, args.pageId)
          const bytes = await page.screenshot({ type: 'png', fullPage: args.fullPage })
          return { content: [
            { type: 'text', text: `Screenshot of tab ${page.pageId}.` },
            { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' },
          ] }
        }
        case 'act': {
          const args = browserInputs.act.parse(rawArgs)
          const result = await stagehand.act(args.instruction, {
            page: await selectPage(browser, args.pageId), timeout: config.operationTimeoutMs,
          })
          if (!result.data.success) throw new Error(result.data.message)
          return textResult(result)
        }
        case 'observe': {
          const args = browserInputs.observe.parse(rawArgs)
          return textResult(await stagehand.observe(args.instruction, {
            page: await selectPage(browser, args.pageId), timeout: config.operationTimeoutMs,
          }))
        }
        case 'extract': {
          const args = browserInputs.extract.parse(rawArgs)
          const options = { page: await selectPage(browser, args.pageId), timeout: config.operationTimeoutMs }
          const result = args.schema === undefined
            ? await stagehand.extract(args.instruction, options)
            : await stagehand.extract(args.instruction, z.fromJSONSchema(args.schema), options)
          return textResult(result)
        }
        /* v8 ignore next -- closed-union exhaustiveness guard; Worker methods are parsed before dispatch. */
        default: return assertNever(method, 'Stagehand browser operation')
      }
    },
  }
}

async function selectPage(browser: StagehandBrowser, pageId: string | undefined): Promise<Page> {
  const page = pageId === undefined
    ? await browser.context.activePage()
    : (await browser.context.pages()).find(candidate => candidate.pageId === pageId)
  if (page === undefined) throw new Error('Stagehand browser tab is unavailable; list tabs to select a current pageId')
  return page
}

function textResult(value: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}
