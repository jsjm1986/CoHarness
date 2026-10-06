/** Independent service application with a durable previous configuration and explicit recovery. */
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { NodeConfigurationError, readNodeConfiguration, writeNodeConfiguration, type NodeConfigurationRecord } from './node-config-store.ts'

/** Host actions installed by the deployment, never supplied in an Admin request. */
export interface NodeConfigurationApplyHost {
  /** Database lease lifetime; aborted owners cannot publish configuration or recovery writes. */
  readonly signal: AbortSignal
  /** Prove node identity, maintenance, paths, ports and database compatibility before publication. */
  preflight(record: NodeConfigurationRecord): Promise<void>
  /** Restart only the declared Gateway service and verify its exact revision and release. */
  restartAndVerify(record: NodeConfigurationRecord): Promise<void>
  /** Test whether an interrupted apply already reached its exact healthy revision. */
  isHealthy(record: NodeConfigurationRecord): Promise<boolean>
}

/**
 * Apply a queued revision, or resolve an interrupted apply without overwriting its previous values.
 * @param file - stable node-owned configuration file.
 * @param environment - bootstrap environment used to validate stored values.
 * @param host - independent lifecycle owner; the caller holds the database maintenance lease throughout.
 * @returns the settled record, or undefined when there is no pending operation.
 */
export async function applyNodeConfiguration(
  file: string, environment: NodeJS.ProcessEnv, host: NodeConfigurationApplyHost,
): Promise<NodeConfigurationRecord | undefined> {
  host.signal.throwIfAborted()
  const initial = await readNodeConfiguration(file, environment)
  if (initial?.operation?.status !== 'pending' && initial?.operation?.status !== 'applying') return undefined
  return withFileLock(file, async () => {
    const record = await readNodeConfiguration(file, environment)
    if (record?.operation?.status !== 'pending' && record?.operation?.status !== 'applying') return undefined
    const operation = record.operation
    if (operation.revision !== record.revision) throw new NodeConfigurationError(409, 'node-configuration-operation-revision-mismatch')
    try {
      await host.preflight(record)
    } catch (error) {
      host.signal.throwIfAborted()
      operation.status = 'failed'
      operation.error = error instanceof Error ? error.message : 'node-configuration-preflight-failed'
      await writeNodeConfiguration(file, record, host.signal)
      return record
    }
    if (operation.status === 'applying') {
      if (record.previous === null) throw new NodeConfigurationError(409, 'node-configuration-recovery-values-missing')
      if (await host.isHealthy(record)) {
        if (record.appliedRevision === operation.revision) {
          operation.status = 'completed'; operation.error = null
        } else {
          operation.status = 'failed'; operation.error = `${operation.error ?? 'interrupted-apply'}; previous-configuration-restored`
        }
        await writeNodeConfiguration(file, record, host.signal)
        return record
      }
      return rollback(record, 'interrupted-node-configuration-apply')
    }
    record.previous = { revision: record.appliedRevision, values: structuredClone(record.applied) }
    record.applied = structuredClone(record.desired)
    record.appliedRevision = record.revision
    operation.status = 'applying'
    operation.error = null
    await writeNodeConfiguration(file, record, host.signal)
    try {
      await host.restartAndVerify(record)
      operation.status = 'completed'
      await writeNodeConfiguration(file, record, host.signal)
      return record
    } catch (error) {
      host.signal.throwIfAborted()
      return rollback(record, error instanceof Error ? error.message : 'node-configuration-apply-failed')
    }

    async function rollback(value: NodeConfigurationRecord, error: string): Promise<NodeConfigurationRecord> {
      host.signal.throwIfAborted()
      if (value.previous === null || value.operation === null) throw new NodeConfigurationError(409, 'node-configuration-recovery-values-missing')
      value.applied = structuredClone(value.previous.values)
      value.appliedRevision = value.previous.revision
      value.operation.error = error
      // The applying state survives another interruption until the previous listener is proven healthy.
      await writeNodeConfiguration(file, value, host.signal)
      try {
        await host.restartAndVerify(value)
        value.operation.error = `${error}; previous-configuration-restored`
      } catch {
        host.signal.throwIfAborted()
        value.operation.error = `${error}; previous-configuration-restart-failed: use node-config recover on this host`
      }
      value.operation.status = 'failed'
      await writeNodeConfiguration(file, value, host.signal)
      return value
    }
  }, { waitMs: 0 })
}

/**
 * Reinstall the retained previous values when Web access is unavailable.
 * @param file - current node's private record, never an arbitrary destination supplied by the Web UI.
 * @param environment - bootstrap environment.
 * @param host - explicit local service actions.
 * @returns recovered record after service health verification; failure keeps the diagnostic record.
 */
export async function recoverNodeConfiguration(file: string, environment: NodeJS.ProcessEnv, host: NodeConfigurationApplyHost): Promise<NodeConfigurationRecord> {
  return withFileLock(file, async () => {
    const record = await readNodeConfiguration(file, environment)
    if (record === undefined || record.previous === null) throw new NodeConfigurationError(409, 'node-configuration-no-previous-values')
    await host.preflight({ ...record, operation: null, desired: structuredClone(record.previous.values) })
    record.applied = structuredClone(record.previous.values)
    record.appliedRevision = record.previous.revision
    if (record.operation !== null) { record.operation.status = 'failed'; record.operation.error = 'local-recovery-in-progress' }
    await writeNodeConfiguration(file, record, host.signal)
    await host.restartAndVerify(record)
    if (record.operation !== null) record.operation.error = 'previous-configuration-restored-by-local-operator'
    await writeNodeConfiguration(file, record, host.signal)
    return record
  }, { waitMs: 0 })
}
