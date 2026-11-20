/** Directory-grant projection only writes an explicitly verified, existing retained home. */
import { existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,expect,it } from 'vitest'
import { writeRuntimeGrantsFile } from '../src/apply-grants.ts'
import { prepareRuntimeProfileDirectory } from '../src/user-data.ts'

const roots:string[]=[]
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'hgw-retained-grants-')));roots.push(root);return root}

it('requires explicit retained authority and never provisions a missing retained directory',()=>{
  const root=fixture(),home=join(root,'retained'),managed=join(root,'managed')
  mkdirSync(home);mkdirSync(managed)
  expect(()=>writeRuntimeGrantsFile(home,[],managed)).toThrow('outside its managed root')
  const path=writeRuntimeGrantsFile(home,[{path:home,mode:'rw',label:'Home'}],managed,{existingHome:true})
  expect(JSON.parse(readFileSync(path,'utf8'))).toEqual([{path:home,mode:'rw',label:'Home'}])
  expect(()=>writeRuntimeGrantsFile(join(root,'missing'),[],managed,{existingHome:true})).toThrow()
  expect(existsSync(join(root,'missing'))).toBe(false)
  expect(existsSync(join(managed,'retained'))).toBe(false)
})

it.skipIf(process.platform==='win32')('rejects aliased homes and grant files without changing other data',()=>{
  const root=fixture(),home=join(root,'retained'),alias=join(root,'alias'),other=join(root,'other.json')
  mkdirSync(home);symlinkSync(home,alias);writeFileSync(other,'original')
  expect(()=>writeRuntimeGrantsFile(alias,[],undefined,{existingHome:true})).toThrow('existing canonical directory')
  symlinkSync(other,join(home,'directory-grants.json'))
  expect(()=>writeRuntimeGrantsFile(home,[],undefined,{existingHome:true})).toThrow('symbolic link')
  expect(readFileSync(other,'utf8')).toBe('original')
})

it('rejects multiply linked grant files before truncating their contents',()=>{
  const root=fixture(),home=join(root,'retained'),other=join(root,'other.json')
  mkdirSync(home);writeFileSync(other,'original');linkSync(other,join(home,'directory-grants.json'))
  expect(()=>writeRuntimeGrantsFile(home,[],undefined,{existingHome:true})).toThrow('identity changed')
  expect(readFileSync(other,'utf8')).toBe('original')
})

it('materializes policy children only inside an existing retained profile root',()=>{
  const root=fixture(),home=join(root,'retained');mkdirSync(home)
  expect(prepareRuntimeProfileDirectory(home,'web',true)).toBe(join(home,'profiles','web','node_modules','@deepseek-ai'))
  expect(()=>prepareRuntimeProfileDirectory(join(root,'missing'),'web',true)).toThrow()
  expect(existsSync(join(root,'missing'))).toBe(false)
})
