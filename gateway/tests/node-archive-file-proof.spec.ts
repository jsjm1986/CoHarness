import { createHash } from 'node:crypto'
import { mkdir,mkdtemp,realpath,rename,rm,symlink,unlink,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect,it } from 'vitest'
import { confirmNodeArchiveFile,verifyNodeArchiveFile } from '../src/node-archive-file-proof.ts'

it('rechecks a retired attachment after foreground work can replace it',async()=>{
  const directory=await mkdtemp(join(await realpath(tmpdir()),'hgw-archive-proof-'))
  try{
    const root=join(directory,'project'),path=join(root,'record')
    await mkdir(root);await writeFile(path,'sample')
    const row={id:'receipt',archive_id:'project-archive',local_path:path,
      expected_bytes:'6',expected_sha256:createHash('sha256').update('sample').digest('hex')}
    const proof=await verifyNodeArchiveFile(row,root)
    await expect(confirmNodeArchiveFile(proof,row,root)).resolves.toBe('match')
    await expect(confirmNodeArchiveFile(proof,{...row,id:'another-receipt'},root)).resolves.toBe('unverified')
    await rename(path,join(root,'old'))
    await writeFile(path,'sample')
    await expect(confirmNodeArchiveFile(proof,row,root)).resolves.toBe('unverified')
    await unlink(path)
    await expect(confirmNodeArchiveFile(proof,row,root)).resolves.toBe('missing')
    await rename(root,join(directory,'moved'))
    await symlink(join(directory,'moved'),root,process.platform==='win32'?'junction':'dir')
    await expect(confirmNodeArchiveFile(proof,row,root)).resolves.toBe('unverified')
  }finally{await rm(directory,{recursive:true,force:true})}
})
