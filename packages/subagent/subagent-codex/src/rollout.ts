/** Exact-turn recovery from Codex's durable rollout events. @module */
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExternalPendingPrompt, ExternalRecovery } from '@deepseek-ai/dsh-subagent/external'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function rolloutPath(externalId: string, storageRoot: string): string | undefined {
  const queue = [join(storageRoot, 'sessions')]
  let found: string | undefined
  for (const directory of queue) {
    let entries: import('node:fs').Dirent<string>[]
    try { entries = readdirSync(directory, { withFileTypes: true, encoding: 'utf8' }) }
    catch { return undefined /* Missing or inaccessible storage cannot prove the bound thread's outcome. */ }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) queue.push(path)
      else if (entry.isFile() && entry.name.endsWith(`-${externalId}.jsonl`)) {
        if (found !== undefined) return undefined
        found = path
      }
    }
  }
  return found
}

/**
 * Recover only a matching prompt and successful terminal event for the persisted turn id.
 * Commentary, another turn, missing data, and a request without an acknowledged id
 * leave the outcome unknown; absence from a rollout never proves non-execution.
 * @param externalId - durable thread identity named by the binding.
 * @param pending - issued prompt and provider-confirmed turn identity.
 * @param storageRoot - the Codex state directory used by the external process.
 * @returns the final answer when the exact turn is proven complete, otherwise unknown.
 */
export function recoverCodexThread(externalId: string, pending: ExternalPendingPrompt, storageRoot = join(homedir(), '.codex')): ExternalRecovery {
  if (pending.externalTurnId === undefined) return { kind: 'unknown' }
  const path = rolloutPath(externalId, storageRoot)
  if (path === undefined) return { kind: 'unknown' }
  let raw: string
  try { raw = readFileSync(path, 'utf8') }
  catch { return { kind: 'unknown' } /* Read failure supplies no execution or completion evidence. */ }
  let active = false, matched = false
  let final: string | undefined, result: string | undefined
  for (const line of raw.split('\n')) {
    if (line === '') continue
    let value: unknown
    try { value = JSON.parse(line) as unknown }
    catch { return { kind: 'unknown' } /* A torn or corrupt record may hide a terminal failure or rollback. */ }
    const entry = object(value), payload = object(entry?.payload)
    if (payload === undefined) return { kind: 'unknown' }
    if (entry?.type === 'event_msg') {
      if (payload.type === 'thread_rolled_back') return { kind: 'unknown' }
      if (payload.type === 'task_started' || payload.type === 'turn_started') {
        active = payload.turn_id === pending.externalTurnId
        if (active) {
          if (matched || result !== undefined) return { kind: 'unknown' }
          final = undefined
        }
      } else if (active && payload.type === 'user_message') {
        if (payload.message !== pending.prompt) return { kind: 'unknown' }
        matched = true
      } else if (active && payload.type === 'turn_aborted') return { kind: 'unknown' }
      else if (active && (payload.type === 'task_complete' || payload.type === 'turn_complete')) {
        if (payload.turn_id !== pending.externalTurnId || !matched || final === undefined
          || (payload.error !== undefined && payload.error !== null) || payload.last_agent_message !== final) return { kind: 'unknown' }
        result = final
        active = false
      }
    } else if (active && entry?.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      if (!Array.isArray(payload.content)) return { kind: 'unknown' }
      const text = payload.content.map(object).flatMap(block => block?.type === 'input_text' ? [block.text] : []).join('')
      if (text === pending.prompt) matched = true
      else if (matched) return { kind: 'unknown' }
    } else if (active && entry?.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant'
      && (payload.phase === 'final_answer' || payload.phase === null || payload.phase === undefined)) {
      if (!Array.isArray(payload.content)) return { kind: 'unknown' }
      const texts: string[] = []
      for (const value of payload.content) {
        const block = object(value)
        if (block?.type !== 'output_text' || typeof block.text !== 'string') return { kind: 'unknown' }
        texts.push(block.text)
      }
      const text = texts.join('')
      if (text.trim() !== '') final = text
    }
  }
  return result === undefined ? { kind: 'unknown' } : { kind: 'result', text: result }
}
