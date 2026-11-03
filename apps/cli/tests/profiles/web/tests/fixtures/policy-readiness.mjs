/** Test-only Loader control in the ordinary Web profile; no alternate application entry. */
export const inject = ['loader', 'webServer', 'gatewayRuntime', 'resourceBudget']

export function apply(ctx, config) {
  const receive = message => {
    if (!['activate', 'disable', 'enable', 'remove', 'fail'].includes(message)) return
    void change(message).then(() => process.send?.({ changed: message }), error => process.send?.({ error: String(error) }))
  }
  ctx.effect(() => {
    process.on('message', receive)
    process.send?.({ port: ctx.webServer.port })
    return () => process.off('message', receive)
  })
  async function change(action) {
    if (action === 'activate') await ctx.loader.root.update([...ctx.loader.root.data, { id: 'policy-acceptance', name: config.plugin }])
    if (action === 'disable') await ctx.loader.update('policy-acceptance', { disabled: true })
    if (action === 'enable') await ctx.loader.update('policy-acceptance', { disabled: false })
    if (action === 'remove') ctx.loader.remove('policy-acceptance')
    if (action === 'fail') await ctx.loader.root.update([...ctx.loader.root.data, { id: 'policy-acceptance', name: config.missingPlugin }])
  }
}
