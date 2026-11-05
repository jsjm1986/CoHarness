/** Hold the actual project recovery work slot until its parent observes exclusion. */
import { PeerProjectFileGate } from '../../src/peer-backup-file-gate.ts'
const root=process.argv[2]
if(!root || !process.send) throw new Error('Expected an isolated worker root and IPC.')
const release=Promise.withResolvers()
process.once('message',message=>{if(message==='release') release.resolve()})
await new PeerProjectFileGate(root,'peer-project-recovery-work').exclusive(71,async()=>{
  process.send('held')
  await release.promise
})
process.disconnect()
