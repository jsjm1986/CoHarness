/** Agent-free pending-input baseline through the shipped Web Loader and HTTP history carrier. */
import { expect, it } from 'vitest'
import { launchWebScaffold, seedSession } from './scaffold.ts'

it.each([0, 200])('serves a cold pending queue after %s turns without activating an Agent', async (turns) => {
  const scaffold = await launchWebScaffold()
  try {
    const id = await seedSession(scaffold, [
      JSON.stringify({ type: 'session', version: 2, id: '{{sessionId}}', createdAt: 1786406400000, cwd: '{{cwd}}' }),
      ...Array.from({ length: turns }, (_, index) => [
        JSON.stringify({ type: 'turn/start', data: { turn: index + 1 } }),
        JSON.stringify({ type: 'step/start', data: { turn: index + 1, step: 1 } }),
        JSON.stringify({ type: 'user/message', surfaceOp: 'append', data: {
          id: `history-${index}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `History ${index}` }],
        } }),
        JSON.stringify({ type: 'step/end', data: { turn: index + 1, step: 1 } }),
        JSON.stringify({ type: 'turn/end', data: { turn: index + 1, reason: { kind: 'completed' } } }),
      ]).flat(),
      JSON.stringify({ type: 'turn/start', data: { turn: turns + 1 } }),
      JSON.stringify({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{
        id: 'cold-pending-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Pending after restart' }],
      }] } }),
      JSON.stringify({ type: 'turn/end', data: { turn: turns + 1, reason: { kind: 'cancelled' } } }),
      '',
    ].join('\n'), 'cold-inbox')
    const response = await fetch(`${scaffold.baseUrl}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'cold-inbox-history', method: 'session.history', payload: { sessionId: id, maxMessages: 1 } }),
    })
    const body = await response.json() as { result: { ok: boolean; value: { projections: { values: { inbox: unknown } } } } }
    expect(response.status).toBe(200)
    expect(body.result.ok).toBe(true)
    expect(body.result.value.projections.values.inbox).toMatchInlineSnapshot(`
      [
        {
          "id": "cold-pending-message",
          "message": {
            "content": [
              {
                "text": "Pending after restart",
                "type": "text",
              },
            ],
            "id": "cold-pending-message",
            "role": "user",
            "source": {
              "kind": "user",
            },
          },
          "placement": "queued",
        },
      ]
    `)
    expect(scaffold.ctx.agents.get(id)).toBeUndefined()
  } finally {
    await scaffold.close()
  }
})
