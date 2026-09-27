// A preset row that records which `fs` implementation its registration
// context resolved — the value a tool body would close over. Import-free on
// purpose: the Loader resolves entry modules through Node's ESM resolver,
// which cannot see this workspace's TypeScript sources.
export const name = 'service-probe'
export const inject = ['tools', 'fs']

export function apply(ctx, config) {
  const captured = ctx.fs
  globalThis.__PROBE_FS__ ??= []
  globalThis.__PROBE_FS__.push({ tool: config.tool, marker: captured?.marker })
  ctx.effect(() => ctx.tools.register({
    name: config.tool,
    description: `fixture probe ${config.tool}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: () => Promise.resolve(captured),
  }))
}
