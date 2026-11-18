/**
 * The globally named `send_message` and `interrupt_agent` tools plus the
 * `subagent:identity` prompt context: thin model-facing adapters over
 * `ctx.subagents.sendMessage()`, `ctx.subagents.resolveName()`, and
 * `ctx.subagents.interrupt()`. They perform no lifecycle routing of their own —
 * residency, cold resume, and interrupt authorization belong to the subagent
 * service — and they live apart from the provider-bound
 * `@deepseek-ai/dsh-tool-subagent` instances so multiple delegation tools share
 * one control API.
 * @module @deepseek-ai/dsh-tool-subagent-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ROOT_AGENT_NAME, SubagentError } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { markAdjacentAgentSendMessageTool } from '@deepseek-ai/dsh-subagent/internal'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

/**
 * Register the `send_message` and `interrupt_agent` tools and the agent
 * identity prompt context.
 * @param ctx - context carrying the tool registry, subagent service, live
 *   Agent registry, and prompt assembly.
 */
export function apply(ctx: Context): void {
  const sendMessage = markAdjacentAgentSendMessageTool(defineTool({
    name: 'send_message',
    description:
      'Send a message to an agent. A working agent receives it at its next step; an idle agent starts a new turn with it. '
      + 'This call returns no answer from the agent — only confirmation that the message was delivered. '
      + 'A failure means the message was NOT delivered.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'The name of another agent in your subagent tree, as shown by list_agents.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `message delivered to agent ${args.agent}`,
      }],
    },
    async execute(args, exec) {
      const sender = exec.agent
      if (!sender) {
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const targetId = await ctx.subagents.resolveName(sender, args.agent, exec.signal)
      const messageId = await ctx.subagents.sendMessage(
        sender,
        targetId,
        message,
        { signal: exec.signal },
      )
      return { messageId }
    },
  }))
  ctx.tools.register(sendMessage)

  ctx.systemPrompt.context({
    name: 'subagent:identity',
    order: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    required: true,
    interpolate: false,
    text: ({ agent, scope, toolSet }) => {
      if (agent === undefined) return ''
      try {
        const names = ctx.subagents.namesOf(agent)
        let identity = names.parent === undefined
          ? `You are the root agent. Your name is ${JSON.stringify(names.self)}.`
          : `You are a subagent delegated by agent ${JSON.stringify(names.parent)}.\n`
            + `Your name is ${JSON.stringify(names.self)}.\n`
            + `The root agent of your collaboration tree is ${JSON.stringify(ROOT_AGENT_NAME)}.`
        const guidance: string[] = []
        if (ctx.tools.get(sendMessage.name, scope, toolSet) === sendMessage) {
          guidance.push('To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).')
        }
        // list_agents lives in a sibling plugin, so availability checks key by name.
        if (ctx.tools.get('list_agents', scope, toolSet) !== undefined) {
          guidance.push('Use list_agents({}) to find your collaborator agents and their names.')
        }
        if (guidance.length > 0) identity += '\n\n' + guidance.join('\n')
        return identity
      } catch (error: unknown) {
        if (!(error instanceof SubagentError) || error.code !== 'UNAUTHORIZED') throw error
        return `Your agent id is ${JSON.stringify(agent.id)}. Your subagent tree root is unavailable. `
          + 'Continue independent work; subagent discovery and messaging require an active root.'
      }
    },
  })

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Request cancellation of a background agent\'s current turn by its name. The target may be your '
      + 'direct child or a deeper agent created under you. Only the current turn stops: messages already '
      + 'queued for the agent stay parked until a later send_message, agents it started keep running, and '
      + 'the agent itself stays available for follow-ups. This call returns as soon as the stop request is '
      + 'accepted, so the target may keep running briefly; interrupting an agent that already finished is '
      + 'an accepted no-op.',
    parameters: {
      agent: {
        type: 'string',
        required: true,
        description: 'The name of an agent created under you: your direct child or a deeper descendant.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent}`,
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // Ancestor authority requires an exact live calling agent.
        throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      }
      const targetId = await ctx.subagents.resolveName(caller, args.agent, exec.signal)
      // The service authorizes the exact live caller against the target's
      // recorded lineage; the tool adds no authority of its own.
      ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent: caller })
      return { accepted: true }
    },
  }))
}
