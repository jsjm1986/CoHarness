// @vitest-environment jsdom
// Durable conversation preferences: TranscriptViewPolicy (with legacy
// values), PerformanceUsagePolicy, LinkOpeningPolicy, and the presentation
// table derived from the work-details mode.

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { TranscriptViewPolicy } from '../src/client/transcript-view.ts'
import { PerformanceUsagePolicy } from '../src/client/performance-usage.ts'
import { LinkOpeningPolicy } from '../src/client/link-opening.ts'
import { derivePresentationPolicy, presentationPolicyFor } from '../src/client/presentation-policy.ts'
import type { ConversationSettings } from '../src/submission-settings.ts'

describe('TranscriptViewPolicy', () => {
  it('defaults to the given mode and stays process-local without a scope', () => {
    const policy = new TranscriptViewPolicy(undefined, 'standard')
    expect(policy.mode.getSnapshot()).toBe('standard')
    policy.setMode('verbose')
    expect(policy.mode.getSnapshot()).toBe('verbose')
    policy.dispose()
  })

  it('maps legacy saved modes onto Detailed and offers them as no new choice', () => {
    const host = stubSettingsScope<ConversationSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    host.publish({
      status: 'ready', writable: true,
      value: {
        busyEnter: 'queue', chatContentWidth: 700, chatFontSize: 13,
        performanceUsage: 'detailed', linkOpening: 'sidebar',
        transcriptView: 'normal',
      },
    })
    expect(policy.mode.getSnapshot()).toBe('detailed')
    host.publish({
      status: 'ready', writable: true,
      value: {
        busyEnter: 'queue', chatContentWidth: 700, chatFontSize: 13,
        performanceUsage: 'detailed', linkOpening: 'sidebar',
        transcriptView: 'expanded',
      },
    })
    expect(policy.mode.getSnapshot()).toBe('detailed')
    policy.dispose()
  })

  it('publishes the choice locally before the durable write and writes through the scope', () => {
    const host = stubSettingsScope<ConversationSettings>()
    host.publish({ status: 'ready', writable: true })
    const observed: string[] = []
    let liveMode = (): string => 'unconstructed'
    const scope: typeof host.scope = {
      ...host.scope,
      set: (field, value) => {
        observed.push(`${field}=${String(value)}:${liveMode()}`)
        return host.scope.set(field, value)
      },
    }
    const policy = new TranscriptViewPolicy(scope)
    liveMode = () => policy.mode.getSnapshot()
    const changed = vi.fn()
    policy.mode.subscribe(changed)
    policy.setMode('compact')
    expect(observed).toEqual(['transcriptView=compact:compact'])
    expect(changed).toHaveBeenCalledOnce()
    policy.dispose()
  })

  it('refuses to stage a choice while the durable scope is read-only', () => {
    const host = stubSettingsScope<ConversationSettings>()
    host.publish({ status: 'ready', writable: false, writableReason: 'provider' })
    const policy = new TranscriptViewPolicy(host.scope)
    policy.setMode('compact')
    expect(policy.mode.getSnapshot()).toBe('detailed')
    expect(host.set).not.toHaveBeenCalled()
    policy.dispose()
  })
})

describe('derivePresentationPolicy', () => {
  it('keeps one stable policy object per mode and follows the mode observable', () => {
    const host = stubSettingsScope<ConversationSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    const presentation = derivePresentationPolicy(policy.mode)
    expect(presentation.getSnapshot()).toBe(presentationPolicyFor('detailed'))
    const changed = vi.fn()
    presentation.subscribe(changed)
    policy.setMode('verbose')
    expect(changed).toHaveBeenCalledOnce()
    expect(presentation.getSnapshot().foldCompletedTurns).toBe(false)
    policy.dispose()
  })

  it('assigns the contracted fields per mode', () => {
    expect(presentationPolicyFor('compact').settledReasoningPreview).toBe(false)
    expect(presentationPolicyFor('verbose').foldCompletedTurns).toBe(false)
    expect(presentationPolicyFor('detailed').foldCompletedTurns).toBe(true)
    expect(presentationPolicyFor('standard').stepGrouping).toBe('collapsed')
    expect(presentationPolicyFor('detailed').stepGrouping).toBe('history')
    expect(presentationPolicyFor('verbose').stepGrouping).toBe('none')
  })
})

describe('PerformanceUsagePolicy', () => {
  it('defaults to Detailed, adopts the accepted value, and persists explicit choices', () => {
    const host = stubSettingsScope<ConversationSettings>()
    const policy = new PerformanceUsagePolicy(host.scope)
    expect(policy.mode.getSnapshot()).toBe('detailed')
    host.publish({
      status: 'ready', writable: true,
      value: {
        busyEnter: 'queue', chatContentWidth: 700, chatFontSize: 13,
        performanceUsage: 'compact', linkOpening: 'sidebar',
      },
    })
    expect(policy.mode.getSnapshot()).toBe('compact')
    policy.setMode('detailed')
    expect(policy.mode.getSnapshot()).toBe('detailed')
    expect(host.set).toHaveBeenCalledWith('performanceUsage', 'detailed')
    policy.dispose()
  })

  it('refuses to stage a choice while the durable scope is read-only', () => {
    const host = stubSettingsScope<ConversationSettings>()
    host.publish({ status: 'ready', writable: false, writableReason: 'provider' })
    const policy = new PerformanceUsagePolicy(host.scope)
    policy.setMode('compact')
    expect(policy.mode.getSnapshot()).toBe('detailed')
    expect(host.set).not.toHaveBeenCalled()
    policy.dispose()
  })
})

describe('LinkOpeningPolicy', () => {
  it('defaults to the sidebar, adopts the accepted value, and persists explicit choices', () => {
    const host = stubSettingsScope<ConversationSettings>()
    const policy = new LinkOpeningPolicy(host.scope)
    expect(policy.destination.getSnapshot()).toBe('sidebar')
    host.publish({
      status: 'ready', writable: true,
      value: {
        busyEnter: 'queue', chatContentWidth: 700, chatFontSize: 13,
        performanceUsage: 'detailed', linkOpening: 'new-tab',
      },
    })
    expect(policy.destination.getSnapshot()).toBe('new-tab')
    policy.setDestination('sidebar')
    expect(policy.destination.getSnapshot()).toBe('sidebar')
    expect(host.set).toHaveBeenCalledWith('linkOpening', 'sidebar')
    policy.dispose()
  })
})
