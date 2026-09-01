// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionIndicator } from '../src/ConnectionIndicator.tsx'

afterEach(cleanup)

const labels = {
  disconnectedLabel: 'Connection lost',
  reconnectLabel: 'Reconnect',
  connectingLabel: 'Connecting',
  recoveredLabel: 'Connected',
  reconnectActionLabel: 'Reconnect now',
  restartActionLabel: 'Restart connection',
}

describe('ConnectionIndicator', () => {
  it('renders nothing while no feedback state is active', () => {
    const view = render(<ConnectionIndicator state={undefined} {...labels} onReconnect={vi.fn()} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('offers an immediate reconnect action for a disconnected connection', () => {
    const onReconnect = vi.fn()
    render(<ConnectionIndicator state="disconnected" {...labels} onReconnect={onReconnect} />)
    const button = screen.getByRole('button', { name: labels.reconnectActionLabel })
    expect(button.textContent).toContain(labels.disconnectedLabel)
    expect(button.textContent).toContain(labels.reconnectLabel)
    fireEvent.click(button)
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('uses the restart action and animated dots while connecting', () => {
    render(<ConnectionIndicator state="connecting" {...labels} onReconnect={vi.fn()} />)
    const button = screen.getByRole('button', { name: labels.restartActionLabel })
    expect(button.textContent).toContain(labels.connectingLabel)
    expect(button.querySelectorAll('span').length).toBeGreaterThan(0)
  })

  it('shows a non-interactive recovered status', () => {
    render(<ConnectionIndicator state="recovered" {...labels} onReconnect={vi.fn()} />)
    expect(screen.getByRole('status', { name: labels.recoveredLabel })).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
