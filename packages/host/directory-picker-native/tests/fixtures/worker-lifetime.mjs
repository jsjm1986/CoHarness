/** Real IPC child lifetime with controlled external window-close and kill outcomes. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

const [mode, scenario] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(['result', 'kill-refused', 'pending-close', 'late-showing'].includes(scenario))
const moduleUrl = mode === 'src' ? new URL('../../src/win32-dialog.ts', import.meta.url)
  : process.env.HGW_TEST_NATIVE_ARTIFACT ? pathToFileURL(process.env.HGW_TEST_NATIVE_ARTIFACT + '/win32-dialog.js')
    : new URL('../../lib/types/win32-dialog.js', import.meta.url)
const { pickWin32Directory } = await import(moduleUrl.href)
const childSource = `
const hold=setInterval(()=>{},1000);
process.on('message',command=>{
 if(command==='report')process.send({kind:'done',path:'C:\\\\picked'});
 if(command==='barrier')process.send({kind:'barrier'});
 if(command==='show')process.send({kind:'showing',threadId:7});
 if(command==='finish'){clearInterval(hold);process.disconnect()}
});
process.send({kind:${JSON.stringify(scenario === 'late-showing' ? 'started' : 'showing')},threadId:7});
`
const controller = new AbortController(), showing = Promise.withResolvers(), killCalled = Promise.withResolvers()
const closeEntered = Promise.withResolvers(), closeCompletion = Promise.withResolvers()
let child, outcome, settled = false, killSignal, closeRequests = 0, terminationRefused = false
const watchdog = setTimeout(() => { child?.kill('SIGKILL') }, 15_000)
const messages = new Map()
const expectMessage = kind => {
  const result = Promise.withResolvers(); messages.set(kind, result); return result.promise
}
const output = value => console.log(JSON.stringify(value))
const spawnWorker = () => {
  child = spawn(process.execPath, ['-e', childSource], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } })
  const listeners = new Map()
  child.on('message', message => {
    messages.get(message.kind)?.resolve(message)
    if (message.kind === 'showing' || message.kind === 'started') showing.resolve()
  })
  child.stdout.resume(); child.stderr.resume()
  return {
    on(event, listener) {
      const actual = event === 'message' ? message => {
        if (['showing', 'done', 'error'].includes(message.kind)) listener(message)
      } : listener
      listeners.set(listener, actual); child.on(event, actual)
      return this
    },
    off(event, listener) { child.off(event, listeners.get(listener) ?? listener); listeners.delete(listener); return this },
    kill(signal) {
      killSignal = signal
      if (scenario === 'late-showing' && !terminationRefused) {
        terminationRefused = true
        child.emit('error', Object.assign(new Error('fixture termination refused'), { code: 'EPERM' }))
      }
      killCalled.resolve(); return false
    },
    unref() { child.unref() },
  }
}
try {
  outcome = pickWin32Directory(controller.signal, {
    spawnWorker, closeRetryMs: 1,
    async closeThreadWindows() {
      closeRequests += 1
      closeEntered.resolve()
      if (scenario === 'pending-close' || scenario === 'late-showing') await closeCompletion.promise
    },
  }).then(value => { settled = true; return { value } }, error => { settled = true; return { error } })
  await showing.promise
  if (scenario === 'result') {
    const reported = expectMessage('done'); child.send('report'); await reported
  } else {
    controller.abort()
    if (scenario === 'kill-refused' || scenario === 'late-showing') {
      await killCalled.promise
      if (scenario === 'late-showing') {
        const reported = expectMessage('showing'); child.send('show'); await reported
      }
    }
    else { await closeEntered.promise; const reported = expectMessage('done'); child.send('report'); await reported }
  }
  const barrier = expectMessage('barrier'); child.send('barrier'); await barrier
  output({ operation: 'before-exit', pending: !settled, childAlive: child.exitCode === null && child.signalCode === null,
    ...scenario === 'kill-refused' ? { forceSignal: killSignal ?? null } : {},
    ...scenario === 'late-showing' ? { closeRequested: closeRequests > 0 } : {} })
  const closed = once(child, 'close'); child.send('finish'); await closed
  if (scenario === 'pending-close' || scenario === 'late-showing') {
    output({ operation: 'after-exit-before-close-completion', pending: !settled })
    closeCompletion.resolve()
  }
  const result = await outcome
  if (scenario === 'result') assert.equal(result.value, 'C:\\picked')
  else assert.match(result.error?.message ?? '', /native directory picker aborted/)
  output({ operation: 'complete', childClosed: child.exitCode !== null || child.signalCode !== null,
    ...scenario === 'result' ? { selected: result.value } : { aborted: true } })
} finally {
  closeCompletion.resolve()
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed
  }
  if (outcome) await outcome
  clearTimeout(watchdog)
}
