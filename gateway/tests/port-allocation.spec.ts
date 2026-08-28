import { describe, expect, it, vi } from 'vitest'
import type { Queryable } from '../src/postgres/database.ts'
import { allocateInstancePorts, INSTANCE_PORT_MAX, INSTANCE_PORT_MIN } from '../src/postgres/port-allocation.ts'

describe('allocateInstancePorts', () => {
  it('asks PostgreSQL for the first free node-local candidates', async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      expect(text).toContain('AS series(candidate)')
      expect(text).toContain('occupied.assigned_node_id=$1')
      expect(values).toEqual(['node-1', 47000, INSTANCE_PORT_MAX, 2])
      return { rows: [{ port: 47000 }, { port: 47002 }], rowCount: 2 }
    })
    await expect(allocateInstancePorts({ query } as unknown as Queryable, 'node-1', 47000, 2, 'node')).resolves.toEqual([47000, 47002])
    expect(query).toHaveBeenCalledOnce()
  })

  it('does not query for an empty batch and rejects invalid ranges', async () => {
    const query = vi.fn()
    await expect(allocateInstancePorts({ query } as unknown as Queryable, 'node-1', INSTANCE_PORT_MIN, 0, 'node')).resolves.toEqual([])
    expect(query).not.toHaveBeenCalled()
    await expect(allocateInstancePorts({ query } as unknown as Queryable, 'node-1', INSTANCE_PORT_MIN - 1, 1, 'node')).rejects.toThrow(/instance port base/)
    await expect(allocateInstancePorts({ query } as unknown as Queryable, 'node-1', INSTANCE_PORT_MIN, -1, 'node')).rejects.toThrow(/allocation count/)
  })

  it('reports exhaustion when PostgreSQL returns fewer candidates', async () => {
    const query = vi.fn(async () => ({ rows: [{ port: 65535 }], rowCount: 1 }))
    await expect(allocateInstancePorts({ query } as unknown as Queryable, 'node-1', 65535, 2, 'node-1')).rejects.toThrow('no instance ports remain on node node-1')
  })
})
