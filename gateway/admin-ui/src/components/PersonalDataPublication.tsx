/** Review and publish one Runtime directory or one account’s shared document history on a selected computer. */
import { useEffect, useRef, useState } from 'react'
import { personalPublication, type RuntimeCatalogEntry } from '../api.ts'
import { adminLanguage } from '../language.ts'
import { usePendingEdits } from '../pending-edits.tsx'
import { Button, Dialog, ErrorBanner, LoadingState } from './ui.tsx'

type Domain='directory'|'documents'
interface Directory {nodeId:string;runtimeId:string;userId:number;generation:number;revision:number|null;workspaces:number;conversations:number;published:boolean;ready:boolean}
interface Documents {nodeId:string;user:number;rootId?:string;catalogDigest?:string;physicalDigest?:string;ready:boolean;blockers:string[];counts:{fileCount:number;historyCount:number}}
type Selection={kind:'directory';preview:Directory}|{kind:'documents';preview:Documents}
function publicationError(cause:unknown,en:boolean):string {
  const message=cause instanceof Error?cause.message:String(cause)
  if(message==='DOCUMENT_MIGRATION_UNAVAILABLE'||message==='node-content/unavailable')
    return en?'Configure and verify this computer’s content storage in Deployment before publishing its history.':'请先在部署页配置并验证当前电脑的内容存储，再发布历史数据'
  return message
}

export function PersonalDataPublication({userId,runtime,available,showComputer,onClose}:{userId:number;runtime:RuntimeCatalogEntry;available:boolean;showComputer:boolean;onClose():void}){
  const en=adminLanguage()==='en', t=(zh:string,english:string)=>en?english:zh
  const [kind,setKind]=useState<Domain>('directory'),[version,setVersion]=useState(0)
  const [selection,setSelection]=useState<Selection|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false)
  const current=useRef<AbortController|null>(null),nodeId=runtime.node.id,id=runtime.id
  usePendingEdits(busy)
  useEffect(()=>{
    const controller=new AbortController();current.current=controller;setSelection(null);setError('');setDone(false)
    if(available){
      const inspect=async():Promise<Selection>=>{
        if(kind==='directory'){
          const preview=await personalPublication<Directory>(kind,userId,id,nodeId,controller.signal)
          if(preview.userId!==userId||preview.runtimeId!==id||preview.nodeId!==nodeId)throw Error(en?'The reviewed location changed.':'审阅位置已变更。')
          return {kind,preview}
        }
        const preview=await personalPublication<Documents>(kind,userId,id,nodeId,controller.signal)
        if(preview.user!==userId||preview.nodeId!==nodeId)throw Error(en?'The reviewed account or computer changed.':'审阅账号或电脑已变更。')
        return {kind,preview}
      }
      void inspect().then(result=>{if(!controller.signal.aborted)setSelection(result)},e=>{if(!controller.signal.aborted)setError(publicationError(e,en))})
    }
    return ()=>{controller.abort()}
  },[kind,userId,id,nodeId,available,version,en])
  async function publish(){
    const owner=current.current
    if(!available||!owner||owner.signal.aborted||busy||!selection||selection.kind!==kind||!selection.preview.ready||
      selection.preview.nodeId!==nodeId||(selection.kind==='directory'?selection.preview.runtimeId!==id||selection.preview.userId!==userId:selection.preview.user!==userId))return
    const data=selection.kind==='directory'?{nodeId,userId,generation:selection.preview.generation,revision:selection.preview.revision}:
      {nodeId,maxRows:10000,maxBytes:32*1024*1024,rootId:selection.preview.rootId,catalogDigest:selection.preview.catalogDigest,physicalDigest:selection.preview.physicalDigest}
    setError('');setBusy(true)
    try {await personalPublication(kind,userId,id,nodeId,owner.signal,data);if(!owner.signal.aborted){setDone(true);setSelection(null)}}
    catch(e){if(!owner.signal.aborted){setError(publicationError(e,en));setSelection(null)}}
    finally{if(!owner.signal.aborted)setBusy(false)}
  }
  const active=selection?.kind===kind?selection:null
  return <Dialog open title={t('本机历史数据','Local history')} onClose={()=>{if(!busy)onClose()}}
    description={showComputer?runtime.node.name:undefined} footer={<><Button disabled={busy} onClick={onClose}>{t('关闭','Close')}</Button>
      <Button disabled={busy||!available} onClick={()=>setVersion(v=>v+1)}>{t('重新检查','Check again')}</Button>
      <Button variant="primary" disabled={!available||!active?.preview.ready||busy} loading={busy} onClick={()=>void publish()}>{t('确认发布','Confirm publication')}</Button></>}>
    <div className="formActions"><Button disabled={busy} aria-pressed={kind==='directory'} onClick={()=>setKind('directory')}>{t('对话与工作区','Conversations and workspaces')}</Button>
      <Button disabled={busy} aria-pressed={kind==='documents'} onClick={()=>setKind('documents')}>{t('账号文档','Account documents')}</Button></div>
    <p className="muted">{kind==='directory'?t('发布这个 Runtime 的历史目录到原电脑。','Publish this Runtime’s conversation directory on its owning computer.'):
      t('同一账号在本机的 Runtime 共用文档目录。发布时保留原文件身份。','This account’s Runtimes share the document directory on this computer. Publication preserves file identities.')}</p>
    {!available?<p role="alert">{t('所选环境已不可用。请关闭后重新选择。','The selected environment is unavailable. Close and select it again.')}</p>:
      done?<p role="status">{t('已发布。','Published.')}</p>:error?<ErrorBanner message={error}/>:!active?<LoadingState label={t('正在核对原始数据','Checking original data')}/>:
      <><p>{active.kind==='directory'?t(`工作区 ${active.preview.workspaces} · 对话 ${active.preview.conversations}`,`${active.preview.workspaces} workspaces · ${active.preview.conversations} conversations`):
        t(`文档 ${active.preview.counts.fileCount} · 历史事件 ${active.preview.counts.historyCount}`,`${active.preview.counts.fileCount} documents · ${active.preview.counts.historyCount} history events`)}</p>
        {!active.preview.ready && <p role="status">{active.kind==='directory'?(active.preview.published?t('此目录已发布。','This directory has been published.'):t('需要所属 Runtime 提供完整的当前目录。','A complete directory from this Runtime is required.')):
          active.preview.blockers.includes('already-published')?t('此文档目录已发布。','This document directory has been published.'):t('当前文件与历史记录尚未满足发布条件。','The current files and history are not ready for publication.')}{active.kind==='documents' && !active.preview.blockers.includes('already-published') && ' ('+active.preview.blockers.join(', ')+')'}</p>}</>}
  </Dialog>
}
