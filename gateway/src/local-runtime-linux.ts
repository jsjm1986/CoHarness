/** Linux cgroup ownership for one recoverable local Runtime generation. */
import { randomUUID } from 'node:crypto'
import { runGatewayChildCommand } from './child-command.ts'
import type { LocalRuntimeOwnerRecord } from './local-runtime-owner.ts'

/** Literal scope argv support established by an actual user-manager launch. */
export type LocalLinuxScopeMode = 'literal-option' | 'literal-default'

/**
 * Probe the user manager before reserving native descendant containment.
 * @param timeoutMs - control-command deadline.
 * @param signal - caller cancellation retained through the native probe.
 * @returns the supported literal argv mode, or absence on hosts without a user manager.
 */
export async function probeLocalLinuxScope(timeoutMs: number, signal?: AbortSignal): Promise<LocalLinuxScopeMode | undefined> {
  signal?.throwIfAborted()
  if (process.platform !== 'linux') return undefined
  const base = ['--user', '--scope', '--quiet', '--collect', `--unit=dsh-runtime-probe-${randomUUID()}`]
  try {
    await runGatewayChildCommand('systemd-run', [...base, '--expand-environment=no', '--', '/bin/true'], timeoutMs, signal)
    return 'literal-option'
  } catch (error) {
    signal?.throwIfAborted()
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr !== 'string' || !/unrecognized option\b.*expand-environment/u.test(stderr)) return undefined
  }
  try {
    await runGatewayChildCommand('systemd-run', [...base, '--', '/bin/true'], timeoutMs, signal)
    return 'literal-default'
  } catch {
    signal?.throwIfAborted()
    // A failed real scope probe leaves the existing POSIX process-group mode selected.
    return undefined
  }
}

/**
 * Derive the native slice from the private, immutable allocation nonce.
 * @param record - exact generation's owner record.
 * @returns its non-reusable unit name, independent of operating-system PIDs.
 */
export function localRuntimeSlice(record: LocalRuntimeOwnerRecord): string {
  return `dshruntime${record.nonce.replaceAll('-', '')}.slice`
}

/**
 * Wrap a Runtime in a scope whose slice also owns independently grouped descendants.
 * @param record - exact native allocation.
 * @param mode - successful literal-argv probe result.
 * @param command - resolved Runtime executable and arguments.
 * @returns the systemd-run executable and literal arguments.
 */
export function localLinuxRuntimeCommand(record: LocalRuntimeOwnerRecord, mode: LocalLinuxScopeMode, command: string[]): string[] {
  const slice = localRuntimeSlice(record)
  return ['systemd-run', '--user', '--scope', '--quiet', '--collect', `--slice=${slice}`,
    `--unit=${slice.replace(/\.slice$/u, '.scope')}`,
    ...mode === 'literal-option' ? ['--expand-environment=no'] : [], '--', ...command]
}

/**
 * Observe the complete slice, including child scopes, before releasing admission.
 * @param record - exact native allocation.
 * @param timeoutMs - control-command deadline.
 * @returns whether the manager confirms no remaining processes; query failures propagate.
 */
export async function localLinuxRuntimeEmpty(record: LocalRuntimeOwnerRecord, timeoutMs: number): Promise<boolean> {
  const { stdout } = await runGatewayChildCommand('systemctl', ['--user', 'show', localRuntimeSlice(record),
    '--property=LoadState', '--property=ActiveState', '--property=TasksCurrent'], timeoutMs)
  const fields = new Map<string, string>()
  for (const line of stdout.trim().split(/\r?\n/u)) {
    const split = line.indexOf('=')
    if (split < 1 || fields.has(line.slice(0, split))) throw new Error('Invalid local Runtime slice observation')
    fields.set(line.slice(0, split), line.slice(split + 1))
  }
  const load = fields.get('LoadState'), active = fields.get('ActiveState'), tasks = fields.get('TasksCurrent')
  if (fields.size !== 3 || !['loaded', 'not-found'].includes(load ?? '')
    || !['active', 'activating', 'deactivating', 'inactive', 'failed'].includes(active ?? '')
    || tasks !== '[not set]' && !/^\d+$/u.test(tasks ?? '')) throw new Error('Invalid local Runtime slice observation')
  return tasks === '0' || ['inactive', 'failed'].includes(active!) && tasks === '[not set]'
}

/**
 * Force all members of the generation's slice to exit and retire its unit.
 * @param record - exact native allocation, recovered without using a saved numeric PID.
 * @param timeoutMs - control-command deadline.
 */
export async function stopLocalLinuxRuntime(record: LocalRuntimeOwnerRecord, timeoutMs: number): Promise<void> {
  if (!await localLinuxRuntimeEmpty(record, timeoutMs)) {
    try {
      await runGatewayChildCommand('systemctl', ['--user', 'kill', '--kill-who=all', '--signal=SIGKILL', localRuntimeSlice(record)], timeoutMs)
    } catch (error) {
      if (!await localLinuxRuntimeEmpty(record, timeoutMs)) throw error
    }
  }
  await runGatewayChildCommand('systemctl', ['--user', 'stop', localRuntimeSlice(record)], timeoutMs)
  if (!await localLinuxRuntimeEmpty(record, timeoutMs)) throw new Error('Local Runtime descendant slice remains occupied')
}
