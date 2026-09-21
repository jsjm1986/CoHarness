import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'workspace-context-compaction'

/** Replace the visible workspace baseline after the first touch is fully projected. */
export function apply(ctx: Context): void {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (result.isError
      || exec.agent === undefined
      || exec.name !== 'read'
      || typeof exec.arguments !== 'object'
      || exec.arguments === null
      || !('file_path' in exec.arguments)
      || exec.arguments.file_path !== 'nested/task.txt') return downstream
    const agent = exec.agent
    const baseline = agent.session.surface.nodes
      .map(seq => agent.session.eventAt(seq))
      .find(event => event?.type === 'user/message'
        && event.data.source.kind === 'agent-instructions'
        && event.data.source.baseline === true)
    if (baseline === undefined) throw new Error('workspace baseline missing before snapshot compaction')
    const compactionId = CompactionId('workspace-context-fixture')
    let turn: number | null = null
    for (let seq = agent.session.seq - 1; seq >= 0; seq -= 1) {
      const event = agent.session.eventAt(SessionSeq(seq))
      if (event === undefined) continue
      if (event.type === 'turn/start') { turn = event.data.turn; break }
      if (event.type === 'turn/end') break
    }
    agent.session.append('compaction/start', { compactionId, turn })
    agent.session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'Earlier context was compacted for this snapshot.' }],
      shadowedRange: { start: baseline.seq, end: baseline.seq },
      shadowedSeqs: [baseline.seq],
      shadowedTokenCount: 0,
      provider: 'snapshot-fixture',
      model: 'snapshot-fixture',
    })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Earlier context was compacted for this snapshot.' }],
      source: compactCheckpointSource(compactionId),
    }), {
      surfaceOp: { op: 'replace', startSeq: baseline.seq, endSeq: baseline.seq },
      sourceEventSeqs: [baseline.seq],
    })
    agent.session.append('compaction/end', { compactionId, turn })
    return downstream
  })
}
