// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { TestClient, remoteDefaultResponses, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

describe('assembled renderer connection recovery', () => {
  it('keeps the mounted root across a transport reconnect', async () => {
    const mock = RemoteMock.create().load(remoteDefaultResponses)
    const client = await TestClient.start({ roster: webApp }, mock, { mount: true })
    onTestFinished(() => client.dispose())
    const root = client.container!.querySelector('[data-slot="root"]')
    expect(root).not.toBeNull()
    expect(client.connection.state.getSnapshot()).toBe('connected')
    const transitions: Array<string | undefined> = []
    const unsubscribe = client.connection.state.subscribe(() => {
      transitions.push(client.connection.state.getSnapshot())
    })

    await act(async () => {
      client.connection.reconnect()
      await vi.waitFor(() => {
        expect(transitions).toContain('reconnecting')
        expect(transitions.at(-1)).toBe('connected')
      })
    })
    unsubscribe()

    expect(client.container!.querySelector('[data-slot="root"]')).toBe(root)
  }, 60_000)
})
