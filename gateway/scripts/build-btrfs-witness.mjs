/** Build the read-only Linux kernel probe alongside the Gateway that will execute it. */
import { execFile } from 'node:child_process'
import { chmod,mkdir,rename,rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve,join } from 'node:path'
import { promisify } from 'node:util'
if(process.platform!=='linux')throw new Error('The Btrfs witness requires Linux kernel headers.')
const root=resolve(import.meta.dirname,'..'),bin=join(root,'libexec')
await mkdir(bin,{recursive:true,mode:0o755})
const tmp=join(bin,'.build-'+randomUUID())
try {
  await promisify(execFile)('cc',['-std=c11','-Wall','-Wextra','-Werror','-O2',join(root,'deploy/node-content/btrfs-witness.c'),'-o',tmp])
  await chmod(tmp,0o755)
  await rename(tmp,join(bin,'hgw-btrfs-witness'))
} finally {await rm(tmp,{force:true})}
