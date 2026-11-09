/** On-demand evidence for the historical copies of one migrated collaborative project. */
import { useEffect, useRef, useState } from 'react'
import { nodeRetirementSummarySchema, type NodeMigrationPreflight, type NodeRetirementSummary } from '../../../src/node-content-migration-protocol.ts'
import { adminComputerRequestUrl } from '../computer-target.ts'
import { Button, ErrorBanner, Field } from '../components/ui.tsx'
import { adminLanguage } from '../language.ts'

const labels={
  policy:['保留策略','Retention policy'],wal:['事务日志','Transaction logs'],backups:['备份','Backups'],
  replicas:['数据库副本','Database replicas'],'cluster-media':['原始存储介质','Original storage media'],
  'other-projections':['其他索引和副本','Other indexes and copies'],
} as const

/** Retain the reviewed computer, Runtime and writer epoch for every change.
 * @param props - latest preflight for a single placement.
 * @returns status and permitted review actions scoped to the current Admin tab.
 */
export function ProjectSourceReview({project}:{project:NodeMigrationPreflight}){
  const zh=adminLanguage()==='zh',t=(cn:string,en:string)=>zh?cn:en
  const [report,setReport]=useState<NodeRetirementSummary|null>(null),[policy,setPolicy]=useState('')
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const active=useRef<AbortController|null>(null)
  useEffect(()=>()=>active.current?.abort(),[])

  async function load(action:'status'|'review'|'finalize'){
    if(active.current)return
    const controller=new AbortController()
    active.current=controller
    setBusy(true);setError('')
    try{
      const query=new URLSearchParams({dshNode:project.nodeId})
      if(action==='status' && report?.reviewId)query.set('review',report.reviewId)
      const suffix=action==='status'?'':'/'+action
      const url=adminComputerRequestUrl('/admin/api/deployment/project-content-migrations/'+project.projectId+'/retirement'+suffix+'?'+query,undefined,'computer')
      const body=action==='review'&&report?{runtimeId:project.runtimeId,writerEpoch:report.writerEpoch,policyDigest:policy.trim()}:
        action==='finalize'&&report?.reviewId?{reviewId:report.reviewId}:undefined
      if(action!=='status' && !body)return
      const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,
        ...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})})
      if(!response.ok){
        if(response.status===403)throw new Error(t('当前账号无权核验此项目。','Your account cannot review this project.'))
        if(response.status===409)throw new Error(t('核验证据已变化，请刷新后重试。','The evidence changed. Refresh the review and try again.'))
        throw new Error(t('暂时无法核验历史副本。请检查所属电脑。','The review is unavailable. Check the project computer.'))
      }
      const value=nodeRetirementSummarySchema.parse(await response.json())
      if(value.projectId!==project.projectId || value.nodeId!==project.nodeId || value.runtimeId!==project.runtimeId ||
        body && value.writerEpoch!==report?.writerEpoch)throw new Error(t('项目归属已变化，请重新检查项目。','The project placement changed. Check the project again.'))
      if(!controller.signal.aborted)setReport(value)
    }catch(cause){
      if(!controller.signal.aborted){
        setError(cause instanceof Error && cause.name==='Error'?cause.message:t('无法读取核验状态。','Could not read the review status.'))
        setReport(null)
      }
    }finally{if(!controller.signal.aborted)setBusy(false);active.current=null}
  }
  const canFinalize=report?.sourceRetirement==='retiring' && report.reviewId && report.knownOrigin &&
    report.originalClusterStillServing===false && !report.retainedRelations.length && !report.outstanding.length
  return <div>
    <Button type="button" loading={busy} disabled={busy} onClick={()=>void load('status')}>
      {report?t('刷新历史副本状态','Refresh historical copies'):t('查看历史副本','Check historical copies')}
    </Button>
    {report && <div aria-live="polite">
      {report.sourceRetirement==='retired'?<p>{t('历史副本处置已核验。','Historical copy retirement is verified.')}</p>:<>
        {!report.knownOrigin && <p>{t('缺少原数据库身份记录，暂时无法完成核验。','The original database identity is unknown. Verification is pending.')}</p>}
        {report.originalClusterStillServing && <p>{t('组织仍在使用原数据库集群。','The organization still uses the original database cluster.')}</p>}
        {report.retainedRelations.length>0 && <p>{t('仍有历史数据的数据表','Tables containing historical data')} · {report.retainedRelations.length}</p>}
        {report.outstanding.length>0 && <p>{t('待核验','Awaiting evidence')} · {report.outstanding.map(d=>labels[d][zh?0:1]).join(zh?'、':', ')}</p>}
        {report.reviewId && <p><a download={'project-'+project.projectId+'-retirement.json'}
          href={adminComputerRequestUrl('/admin/api/deployment/project-content-migrations/'+project.projectId+'/retirement?'+new URLSearchParams({
            dshNode:project.nodeId,review:report.reviewId}),undefined,'computer')}>
          {t('下载独立核验所需的核验单','Download evidence request')}
        </a></p>}
        {report.knownOrigin && !report.reviewId && <>
          <Field label={t('保留策略 SHA-256','Retention policy SHA-256')}>
            <input className="input" aria-label={t('保留策略 SHA-256','Retention policy SHA-256')} value={policy}
              autoComplete="off" spellCheck={false} onChange={e=>setPolicy(e.target.value)} />
          </Field>
          <Button type="button" disabled={busy || !/^[a-f0-9]{64}$/u.test(policy.trim())} onClick={()=>void load('review')}>{t('开始核验','Open review')}</Button>
        </>}
        {canFinalize && <Button type="button" disabled={busy} onClick={()=>void load('finalize')}>{t('登记处置完成','Record verified retirement')}</Button>}
      </>}
    </div>}
    <ErrorBanner message={error}/>
  </div>
}
