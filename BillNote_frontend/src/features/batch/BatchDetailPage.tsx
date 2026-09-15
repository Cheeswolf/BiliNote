import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Film, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTaskStore } from '@/store/taskStore'
import { pollingErrorMessage } from '@/utils/polling'
import { pauseBatch, resumeBatch, retryFailed, cancelPending } from './api'
import { useBatchStore } from './store'
import { useBatchPolling } from './useBatchPolling'
import { batchLabels, dateLabel, durationLabel, jobLabels, platformLabel } from './presentation'
import type { BatchDetail } from './types'
import BatchProgress from './BatchProgress'
import BatchShell from './BatchShell'

export default function BatchDetailPage() {
  const { batchId } = useParams<{ batchId: string }>()
  const navigate = useNavigate()
  const active = useBatchStore(state => state.active)
  const connection = useBatchStore(state => state.connection)
  const pollingError = useBatchStore(state => state.error)
  const tasks = useTaskStore(state => state.tasks)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useBatchPolling(batchId, 3000, refresh)
  const detail = active?.id === batchId ? active : null
  const action = async (mutation: (id: string) => Promise<BatchDetail>) => {
    if (!batchId || busy) return
    setBusy(true)
    setError(null)
    try {
      await mutation(batchId)
      if (useBatchStore.getState().active?.id === batchId) {
        useBatchStore.getState().setActive(null)
      }
      // Let the existing polling hook serialize the immediate authoritative refresh.
      setRefresh(value => value + 1)
    } catch (error) { setError(pollingErrorMessage(error)) }
    finally { setBusy(false) }
  }
  const openNote = (taskId: string) => {
    try {
      useTaskStore.getState().setCurrentTask(taskId)
      navigate('/')
    } catch (error) { setError(pollingErrorMessage(error)) }
  }
  return (
    <BatchShell>
      <Link to="/batch" className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft className="h-4 w-4" />批量任务中心</Link>
      {connection !== 'online' && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{connection === 'offline' ? '连接中断，将自动重试。' : '正在重连…'} 显示最近一次任务状态。</p>}
      {(error || pollingError) && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error || pollingError}</p>}
      {!detail ? <div className="py-12 text-center text-muted-foreground"><p role="status">{pollingError ? '暂时无法加载批次，将自动重试。' : '加载批次详情…'}</p></div> : <>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2"><h1 className="break-words text-2xl font-semibold">{detail.name}</h1><p className="text-sm text-muted-foreground">{detail.source_label} · {dateLabel(detail.created_at)}</p></div>
          <span className="rounded-full border bg-white px-3 py-1 text-sm">{batchLabels[detail.status]}</span>
        </div>
        <section className="space-y-5 rounded-xl border bg-white p-5">
          <BatchProgress batch={detail} />
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {['PENDING', 'RUNNING'].includes(detail.status) &&
              <Button variant="outline" disabled={busy} onClick={() => { void action(pauseBatch) }}>停止后续任务</Button>}
            {['PAUSED', 'RECOVERABLE'].includes(detail.status) &&
              <Button disabled={busy} onClick={() => { void action(resumeBatch) }}>继续生成</Button>}
            <Button variant="outline" disabled={busy || detail.counts.FAILED + detail.counts.INTERRUPTED === 0}
              onClick={() => { void action(retryFailed) }}>重试失败项</Button>
            <Button variant="outline" disabled={busy || detail.counts.PENDING === 0}
              onClick={() => { void action(cancelPending) }}>取消等待项</Button>
            {busy && <Loader2 aria-label="正在更新批次" className="h-5 w-5 animate-spin self-center" />}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">停止后续任务会让当前执行项完成，并暂停后续生成。取消等待项会立即取消尚未开始的视频，当前执行项继续运行。重试失败项也会恢复已中断项，成功笔记保留。</p>
          {detail.status === 'RECOVERABLE' && <p className="text-sm text-amber-800">上次生成已中断，请点击“继续生成”手动恢复。</p>}
        </section>
        <section className="space-y-3" aria-label="批次视频">
          <h2 className="text-sm font-medium">视频列表 · 按输入顺序执行</h2>
          {[...detail.jobs].sort((a, b) => a.position - b.position).map(job => {
            const ready = tasks.some(task => task.id === job.task_id && task.status === 'SUCCESS')
            return <article key={job.task_id} className="flex items-start gap-4 rounded-xl border bg-white p-4">
              <span className="pt-1 text-sm text-muted-foreground">{job.position + 1}</span>
              {job.cover_url ? <img src={job.cover_url} alt="" referrerPolicy="no-referrer" loading="lazy" className="hidden h-16 w-28 shrink-0 rounded-md bg-neutral-100 object-cover sm:block" />
                : <div className="hidden h-16 w-28 shrink-0 items-center justify-center rounded-md bg-neutral-100 sm:flex"><Film className="h-6 w-6 text-neutral-400" /></div>}
              <div className="min-w-0 flex-1 space-y-2">
                <h3 className="break-words text-sm font-medium">{job.title || job.normalized_url}</h3>
                <p className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{platformLabel(job.platform)}</span><span>{durationLabel(job.duration)}</span><span>尝试 {job.attempt}</span></p>
                <p className="break-all text-xs text-muted-foreground">{job.normalized_url}</p>
                {job.error_message && <p className="break-words text-sm text-red-700">{job.error_message}</p>}
              </div>
              <div className="shrink-0 space-y-2 text-right">
                <p className={'text-sm ' + (job.status === 'SUCCESS' ? 'text-emerald-700' : ['FAILED', 'INTERRUPTED'].includes(job.status) ? 'text-amber-800' : 'text-neutral-600')}>{jobLabels[job.status]}</p>
                {job.status === 'SUCCESS' && <>
                  <Button size="sm" variant="outline" disabled={!ready} onClick={() => openNote(job.task_id)}>打开笔记</Button>
                  {!ready && <p className="max-w-28 text-xs text-muted-foreground">正在载入笔记，将自动重试</p>}
                </>}
              </div>
            </article>
          })}
        </section>
      </>}
    </BatchShell>
  )
}
