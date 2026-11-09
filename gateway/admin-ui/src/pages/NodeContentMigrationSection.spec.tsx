/** A reviewed selection remains local to its Admin tab and never publishes the next project by mistake. */
// @vitest-environment happy-dom
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react'
import { afterEach,expect,it,vi } from 'vitest'
import { NodeContentMigrationSection } from './NodeContentMigrationSection.tsx'
import { ProjectSourceReview } from './ProjectSourceReview.tsx'
import { nodeMigrationPreflightSchema } from '../../../src/node-content-migration-protocol.ts'
const node='10000000-0000-4000-8000-000000000001',runtime='20000000-0000-4000-8000-000000000001'
const snapshot={id:'30000000-0000-4000-8000-000000000001',jobId:'40000000-0000-4000-8000-000000000001',sourceRevision:'9'}
const initial={nodeId:node,runtimeId:runtime,projectId:7,generation:4,storage:'shared',sourceRetirement:null,snapshot:null,sourceRevision:null,
  blockers:['prepare-required','runtime-busy'],missingAdapters:[],canPrepare:true,canPublish:false}
const staged={...initial,snapshot,sourceRevision:'9',blockers:[],canPublish:true}
const packet=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})
afterEach(()=>{cleanup();vi.unstubAllGlobals();window.history.replaceState(null,'','/admin')})

it('keeps historical retirement bound to the reviewed writer and waits for independent evidence',async()=>{
  const project=nodeMigrationPreflightSchema.parse({...staged,storage:'node',sourceRetirement:'retiring'})
  const review='50000000-0000-4000-8000-000000000001'
  const pending={projectId:7,nodeId:node,runtimeId:runtime,writerEpoch:'2',sourceRetirement:'retiring',
    knownOrigin:true,originalClusterStillServing:false,retainedRelations:[],outstanding:['wal'],reviewId:null}
  const call=vi.fn().mockResolvedValueOnce(packet(pending)).mockResolvedValueOnce(packet({...pending,reviewId:review}))
    .mockResolvedValueOnce(packet({...pending,reviewId:review,outstanding:[]})).mockResolvedValueOnce(packet({...pending,reviewId:review,outstanding:[],sourceRetirement:'retired'}))
  vi.stubGlobal('fetch',call)
  render(<ProjectSourceReview project={project}/>)
  expect(call).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:/查看历史副本|Check historical copies/u}))
  const digest=await screen.findByRole('textbox')
  fireEvent.change(digest,{target:{value:'4'.repeat(64)}})
  fireEvent.click(screen.getByRole('button',{name:/开始核验|Open review/u}))
  expect((await screen.findByRole('link')).getAttribute('href')).toContain('dshNode='+node+'&review='+review)
  expect(JSON.parse(call.mock.calls[1]![1].body)).toEqual({runtimeId:runtime,writerEpoch:'2',policyDigest:'4'.repeat(64)})
  expect(screen.queryByRole('button',{name:/登记处置完成|Record verified/u})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:/刷新历史副本|Refresh historical/u}))
  fireEvent.click(await screen.findByRole('button',{name:/登记处置完成|Record verified/u}))
  await screen.findByText(/历史副本处置已核验|Historical copy retirement is verified/u)
  expect(call.mock.calls.at(-1)![0]).toContain('7/retirement/finalize?dshNode='+node)
  expect(JSON.parse(call.mock.calls.at(-1)![1].body)).toEqual({reviewId:review})
})

it('fetches only on selection and confirms a node-qualified reviewed snapshot before switching storage',async()=>{
  window.history.replaceState(null,'',`/admin/computers/${node}/deployment`)
  const call=vi.fn().mockResolvedValueOnce(packet({items:[{id:7,name:'协作空间'}],next:null})).mockResolvedValueOnce(packet(initial))
    .mockResolvedValueOnce(packet(staged)).mockResolvedValueOnce(packet({...staged,storage:'node',sourceRetirement:'retiring',canPrepare:false,canPublish:false}))
  vi.stubGlobal('fetch',call)
  render(<NodeContentMigrationSection/>)
  expect(call).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:/选择项目|Choose a project/u}))
  fireEvent.change(await screen.findByRole('combobox'),{target:{value:'7'}})
  fireEvent.click(screen.getByRole('button',{name:/检查项目|Check project/u}))
  expect(await screen.findByText(/等待任务完成|Let active work finish/u)).toBeTruthy()
  expect(screen.queryByRole('button',{name:/切换项目存储|Switch project storage/u})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:/准备副本|Prepare copy/u}))
  fireEvent.click(await screen.findByRole('button',{name:/切换项目存储|Switch project storage/u}))
  expect(call).toHaveBeenCalledTimes(3)
  fireEvent.click(screen.getByRole('button',{name:/确认切换|Confirm switch/u}))
  await waitFor(()=>expect(screen.getByText(/旧数据库仍保留|still retains a historical copy/u)).toBeTruthy())
  const [url,request]=call.mock.calls.at(-1)!
  expect(url).toBe(`/admin/api/deployment/project-content-migrations/7/publish?dshNode=${node}`)
  expect(JSON.parse(request.body)).toEqual({nodeId:node,runtimeId:runtime,generation:4,snapshot})
})

it('drops a previous preflight after another project is selected and denies mismatched owner responses',async()=>{
  window.history.replaceState(null,'',`/admin/computers/${node}/deployment`)
  const call=vi.fn().mockResolvedValueOnce(packet({items:[{id:7,name:'A'},{id:8,name:'B'}],next:null})).mockResolvedValueOnce(packet(staged))
    .mockResolvedValueOnce(packet({...staged,projectId:8,nodeId:'10000000-0000-4000-8000-000000000002'}))
  vi.stubGlobal('fetch',call);render(<NodeContentMigrationSection/>)
  fireEvent.click(screen.getByRole('button',{name:/选择项目|Choose a project/u}))
  const select=await screen.findByRole('combobox');fireEvent.change(select,{target:{value:'7'}})
  fireEvent.click(screen.getByRole('button',{name:/检查项目|Check project/u}));await screen.findByRole('button',{name:/切换项目存储|Switch project storage/u})
  fireEvent.change(select,{target:{value:'8'}})
  expect(screen.queryByRole('button',{name:/切换项目存储|Switch project storage/u})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:/检查项目|Check project/u}));await screen.findByRole('alert')
  expect(screen.queryByRole('button',{name:/切换项目存储|Switch project storage/u})).toBeNull()
})
