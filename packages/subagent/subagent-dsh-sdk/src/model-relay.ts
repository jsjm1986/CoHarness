/** Parent middleware and authorization retained for one child model stream. */
import type { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import { assertModelPolicy, authorizeModelPolicy, captureModelPolicy, deepFreeze, LlmError,
  type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ModelChannel } from './channel.ts'

/** Parent-owned input/output rendezvous and original model-policy identity. */
export class ParentModelRelay {
  /** Cancels child dispatch and pending model permits when the span closes. */
  readonly controller = new AbortController()
  /** Validated child-adapter chunks; each send waits for parent consumption. */
  readonly input = new ModelChannel<StreamChunk>()
  /** Parent-transformed chunks awaiting child consumption. */
  readonly output = new ModelChannel<StreamChunk>()
  /** Delivered model permits required for dispatch authorization. */
  readonly leases = new Set<ResourceLease>()
  /** Frozen child request bound to the initiating Session and span cancellation. */
  readonly options: GenerateOptions
  /** Parent middleware completion; failure is delivered through the output channel. */
  readonly work: Promise<void>
  private readonly policy: ReturnType<typeof captureModelPolicy>
  private dispatch: boolean | undefined
  private finished = false
  private scope: (<T>(work: () => T) => T) | undefined

  /** @param ctx - actual parent context. @param parentId - retained initiating Session. @param options - validated child model input. */
  constructor(private readonly ctx: Context, private readonly parentId: SessionId, options: GenerateOptions) {
    this.policy = captureModelPolicy(ctx)
    this.options = deepFreeze({ ...options, sessionId: parentId, resourceOrigin: 'execution', signal: this.controller.signal })
    this.work = this.run()
  }

  private async run(): Promise<void> {
    try {
      const llm = this.ctx.get('llm')
      if (llm === undefined) throw new LlmError('SDK child model governance requires the parent LLM service.', 'MODEL_POLICY_UNAVAILABLE')
      assertModelPolicy(this.ctx, this.policy)
      for await (const chunk of this.ctx.waterfall(llm, 'llm/delegated-stream', this.options, () => this.receive())) {
        this.dispatch ??= false
        await this.output.push(chunk)
      }
      this.dispatch ??= false
      this.output.close()
    } catch (error) {
      this.dispatch ??= false
      this.output.close(error instanceof Error ? error : new Error('Parent model middleware failed.', { cause: error }))
    } finally {
      this.finished = true
      this.input.close()
    }
  }

  private async* receive(): AsyncIterable<StreamChunk> {
    this.controller.signal.throwIfAborted()
    this.scope = AsyncLocalStorage.snapshot()
    this.dispatch = true
    for (;;) {
      const item = await this.input.take(this.controller.signal)
      if (item.done) return
      yield item.value
    }
  }

  /**
   * Distinguish pending middleware from child dispatch or a parent short circuit.
   * @returns whether middleware reached the real child body, or is still preparing.
   */
  ready(): { pending: true } | { dispatch: boolean } {
    return this.dispatch === undefined ? { pending: true } : { dispatch: this.dispatch }
  }

  /**
   * Apply live parent guards to the child's resolved request after real model admission.
   * @param options - validated exact request at the child adapter dispatch point.
   */
  async authorize(options: GenerateOptions): Promise<void> {
    if (this.finished || this.dispatch !== true || this.leases.size === 0) throw new LlmError('SDK model admission is unavailable.', 'MODEL_POLICY_UNAVAILABLE')
    if (options.provider !== this.options.provider || options.model !== this.options.model) {
      throw new LlmError('SDK model route changed after request admission.', 'INVALID_PREPARED_CALL')
    }
    const signal = AbortSignal.any([this.controller.signal, ...[...this.leases].map(lease => lease.signal)])
    signal.throwIfAborted()
    assertModelPolicy(this.ctx, this.policy)
    const guarded = deepFreeze({ ...options, sessionId: this.parentId, resourceOrigin: 'execution' as const, signal })
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new LlmError('SDK parent LLM service is unavailable.', 'MODEL_POLICY_UNAVAILABLE')
    await this.inScope(async () => {
      await this.ctx.waterfall(llm, 'llm/pre-dispatch', guarded, () => Promise.resolve())
      await this.ctx.serial(llm, 'llm/authorize', guarded)
      authorizeModelPolicy(this.ctx, this.policy, guarded)
    })
    signal.throwIfAborted()
  }

  /**
   * Restore the live parent middleware context for resource admission and authorization.
   * @param work - resource or policy operation.
   * @returns the operation's result under the retained parent scope.
   */
  inScope<T>(work: () => T): T {
    if (this.scope === undefined) throw new LlmError('SDK parent middleware is not ready.', 'MODEL_POLICY_UNAVAILABLE')
    return this.scope(work)
  }

  /** Mark child adapter and cleanup completion after its final frame was acknowledged. */
  finishInput(): void { this.input.close() }

  /** Stop retained work and wake both HTTP relay directions. */
  cancel(): void {
    const error = new LlmError('SDK parent model stream was cancelled.', 'ABORTED')
    this.controller.abort(error)
    this.input.close(error)
    this.output.close(error)
  }
}
