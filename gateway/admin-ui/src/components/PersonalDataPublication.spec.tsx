import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {PersonalDataPublication} from './PersonalDataPublication.tsx'
import {personalPublication,type RuntimeCatalogEntry} from '../api.ts'
vi.mock('../api.ts',()=>({personalPublication:vi.fn()}))
vi.mock('../language.ts',async load=>({...await load<typeof import('../language.ts')>(),adminLanguage:()=>'en'}))
vi.mock('../pending-edits.tsx',()=>({usePendingEdits:()=>{}}))
const runtime={id:'selected-runtime',node:{id:'selected-node',name:'Selected'}} as RuntimeCatalogEntry
const initial={nodeId:'selected-node',runtimeId:'selected-runtime',userId:4,generation:2,revision:8,workspaces:2,conversations:7,published:false,ready:true}
afterEach(()=>{cleanup();vi.resetAllMocks()})
it('submits the exact inspected directory revision and requires a fresh review after an uncertain reply',async()=>{
  const call=vi.mocked(personalPublication);call.mockResolvedValueOnce(initial).mockRejectedValueOnce(Error('stale selection'))
  render(<PersonalDataPublication userId={4} runtime={runtime} showComputer available onClose={()=>{}}/>)
  await screen.findByText('2 workspaces · 7 conversations')
  fireEvent.click(screen.getByRole('button',{name:'Confirm publication'}))
  expect(call).toHaveBeenLastCalledWith('directory',4,runtime.id,runtime.node.id,expect.any(AbortSignal),
    {userId:4,nodeId:runtime.node.id,generation:2,revision:8})
  await screen.findByText('stale selection')
  expect((screen.getByRole('button',{name:'Confirm publication'}) as HTMLButtonElement).disabled).toBe(true)
})
it('keeps the account document preview lazy and rejects a reply from the other computer',async()=>{
  const call=vi.mocked(personalPublication);call.mockResolvedValueOnce(initial)
  render(<PersonalDataPublication userId={4} runtime={runtime} showComputer available onClose={()=>{}}/>)
  await screen.findByText('2 workspaces · 7 conversations')
  expect(call).toHaveBeenCalledTimes(1)
  call.mockResolvedValueOnce({user:4,nodeId:'other',ready:true,rootId:'other-root'})
  fireEvent.click(screen.getByRole('button',{name:'Account documents'}))
  await screen.findByText('The reviewed account or computer changed.')
  await waitFor(()=>expect((screen.getByRole('button',{name:'Confirm publication'}) as HTMLButtonElement).disabled).toBe(true))
  expect(call).toHaveBeenCalledTimes(2)
})
it('explains missing local content storage while keeping publication disabled',async()=>{
  const call=vi.mocked(personalPublication);call.mockResolvedValueOnce(initial).mockRejectedValueOnce(Error('DOCUMENT_MIGRATION_UNAVAILABLE'))
  render(<PersonalDataPublication userId={4} runtime={runtime} showComputer available onClose={()=>{}}/>)
  await screen.findByText('2 workspaces · 7 conversations')
  fireEvent.click(screen.getByRole('button',{name:'Account documents'}))
  await screen.findByText('Configure and verify this computer’s content storage in Deployment before publishing its history.')
  expect((screen.getByRole('button',{name:'Confirm publication'}) as HTMLButtonElement).disabled).toBe(true)
})
