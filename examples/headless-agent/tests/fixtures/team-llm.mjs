/** Deterministic keyless Agent Teams adapter for the real headless Loader snapshot. */

import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'

let nextCall = 0

function calls(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
    : [])
}

function latestAssistantCalls(messages) {
  const assistant = messages.findLast(message => message.role === 'assistant')
  return assistant?.content.filter(block => block.type === 'tool-call').map(block => block.name) ?? []
}

function hasTaskAction(messages, action) {
  return messages.some(message => message.role === 'assistant'
    && message.content.some((block) => {
      if (block.type !== 'tool-call' || block.name !== 'team_task_update') return false
      try {
        return JSON.parse(block.arguments).action === action
      } catch {
        return false
      }
    }))
}

function latestToolText(messages) {
  const message = messages.findLast(candidate => candidate.role === 'tool')
  if (message === undefined) return ''
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function userText(messages) {
  return messages.flatMap(message => message.role === 'user'
    ? message.content.filter(block => block.type === 'text').map(block => block.text)
    : []).join('\n')
}

function toolChunks(specs) {
  const chunks = []
  for (const [index, spec] of specs.entries()) {
    const id = ToolCallId(`team-fixture-${++nextCall}`)
    const args = JSON.stringify(spec.args)
    chunks.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: spec.name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: spec.name, arguments: args } },
    )
  }
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function researcher(messages) {
  const names = calls(messages)
  if (!names.includes('team_task_create')) {
    return toolChunks([{ name: 'team_task_create', args: {
      subject: 'Research', description: 'Collect the deterministic finding.', write_scopes: ['research'],
    } }])
  }
  if (!names.includes('team_task_update')) {
    return toolChunks([{ name: 'team_task_update', args: {
      task_id: 'task-1', expected_revision: 1, action: 'claim',
    } }])
  }
  if (!names.includes('send_message')) {
    return toolChunks([
      { name: 'team_task_update', args: { task_id: 'task-1', expected_revision: 2, action: 'complete' } },
      { name: 'send_message', args: { agent: 'implementer', message: 'Research complete: use the deterministic finding.' } },
    ])
  }
  return textChunks('Research teammate complete.')
}

function implementer(messages) {
  const names = calls(messages)
  const last = latestAssistantCalls(messages)
  const text = latestToolText(messages)
  const informed = userText(messages).includes('Research complete')
  if (!names.includes('team_task_get')) return toolChunks([{ name: 'team_task_get', args: { task_id: 'task-1' } }])
  if (!informed) {
    // The first pass may run before task-1 exists (not-found error) or while it
    // is still open; either way this turn ends and the researcher's send_message
    // starts the follow-up turn.
    return textChunks('Waiting for the research finding.')
  }
  if (!names.includes('team_task_create')) {
    if (text.includes('"status":"completed"')) {
      return toolChunks([{ name: 'team_task_create', args: {
        subject: 'Implementation',
        description: 'Apply the deterministic finding.',
        blocked_by: ['task-1'],
        write_scopes: ['implementation'],
      } }])
    }
    return toolChunks([{ name: 'team_task_get', args: { task_id: 'task-1' } }])
  }
  if (!hasTaskAction(messages, 'claim')) {
    return toolChunks([{ name: 'team_task_update', args: {
      task_id: 'task-2', expected_revision: 1, action: 'claim',
    } }])
  }
  if (!names.includes('send_message')) {
    return toolChunks([
      { name: 'team_task_update', args: { task_id: 'task-2', expected_revision: 2, action: 'complete' } },
      { name: 'send_message', args: { agent: 'lead', message: 'Implementation complete and verified.' } },
    ])
  }
  return textChunks('Implementation teammate complete.')
}

function lead(messages) {
  const names = calls(messages)
  const last = latestAssistantCalls(messages)
  const text = latestToolText(messages)
  const spawned = names.filter(name => name === 'subagent').length
  if (spawned === 0) {
    return toolChunks([{
      name: 'subagent',
      args: {
        description: 'Own deterministic implementation',
        name: 'implementer',
        prompt: 'IMPLEMENTER_MARK: wait for research, complete dependent task 2, report to lead.',
      },
    }])
  }
  if (spawned === 1) {
    return toolChunks([{
      name: 'subagent',
      args: {
        description: 'Own deterministic research',
        name: 'researcher',
        prompt: 'RESEARCHER_MARK: complete research task 1, message implementer, then finish.',
      },
    }])
  }
  if (last.includes('list_agents')) {
    const inactive = text.match(/\[inactive\]/gu)?.length ?? 0
    if (inactive >= 2) return textChunks('TEAM_WORKFLOW_OK: both teammates and dependent tasks completed.')
    if (names.filter(name => name === 'list_agents').length >= 50) {
      return textChunks('Waiting for teammates to settle.')
    }
    return toolChunks([{ name: 'list_agents', args: {} }])
  }
  if (last.includes('team_task_list')) {
    const completed = text.match(/"status":"completed"/gu)?.length ?? 0
    if (completed >= 2) return toolChunks([{ name: 'list_agents', args: {} }])
    // The Lead must keep its turn alive: v2 has no wait tool, so peer
    // `send_message` deliveries steer into this turn only while it runs.
    // Text without a tool call ends the run before teammates can report.
    if (names.filter(name => name === 'team_task_list').length >= 200) {
      return textChunks('Waiting for shared tasks to complete.')
    }
    return toolChunks([{ name: 'team_task_list', args: {} }])
  }
  return toolChunks([{ name: 'team_task_list', args: {} }])
}

class TeamFixtureAdapter extends LlmAdapter {
  async * stream(options) {
    const text = userText(options.messages)
    const chunks = text.includes('RESEARCHER_MARK')
      ? researcher(options.messages)
      : text.includes('IMPLEMENTER_MARK')
        ? implementer(options.messages)
        : lead(options.messages)
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** Cordis plugin name. */
export const name = 'team-fixture-llm'
/** LLM registry dependency. */
export const inject = ['llm']

/** Register the keyless adapter on the shipped default provider route. */
export function apply(ctx) {
  ctx.llm.registerAdapter(['deepseek-official'], new TeamFixtureAdapter())
}
