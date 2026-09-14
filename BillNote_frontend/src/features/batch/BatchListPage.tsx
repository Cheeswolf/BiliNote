import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { pollingErrorMessage } from '@/utils/polling'
import { listBatches } from './api'
import { useBatchStore } from './store'
import { isTerminalBatch } from './types'
import { batchLabels, dateLabel } from './presentation'
import BatchShell from './BatchShell'
import BatchProgress from './BatchProgress'

export default function BatchListPage() {
  const list = useBatchStore(state => state.list)
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const load = async () => {
      while (inFlight.current) await inFlight.current
      if (cancelled) return
      const run = async () => {
        setBusy(true)
        try {
          const next = await listBatches(page, 20)
          if (cancelled) return
          useBatchStore.getState().setList(next)
          setError(null)
          failures = 0
          if (next.items.some(batch => !isTerminalBatch(batch.status))) {
            timer = setTimeout(() => { void load() }, 5000)
          }
        } catch (error) {
          if (cancelled) return
          setError(pollingErrorMessage(error))
          failures += 1
          timer = setTimeout(() => { void load() }, Math.min(5000 * 2 ** failures, 30000))
        } finally { if (!cancelled) setBusy(false) }
      }
      const request = run()
      inFlight.current = request
      await request
      if (inFlight.current === request) inFlight.current = null
    }
    void load()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [page, refresh])
  const visible = list?.page === page ? list : null
  const batches = visible?.items ?? []
  const completed = batches.filter(batch => batch.status === 'COMPLETED').length
  const abnormal = batches.filter(batch => ['PARTIAL', 'RECOVERABLE', 'CANCELLED'].includes(batch.status)).length
  return (
    <BatchShell>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h1 className="text-2xl font-semibold">批量任务中心</h1><p className="mt-2 text-sm text-muted-foreground">集中查看生成进度，继续未完成的笔记。</p></div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw className={'h-4 w-4 ' + (busy ? 'animate-spin' : '')} />刷新</Button>
          <Button asChild><Link to="/batch/new"><Plus className="h-4 w-4" />新建批量任务</Link></Button>
        </div>
      </div>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error} · 将自动重试，也可点击刷新。</p>}
      <section aria-label="本页概览" className="space-y-3">
        <p className="text-xs text-muted-foreground">本页概览 · 共 {list?.total ?? 0} 个批次</p>
        <div className="grid grid-cols-3 gap-3">
          <p className="rounded-xl border bg-white p-4 text-sm font-medium sm:text-lg">处理中 {batches.length - completed - abnormal}</p>
          <p className="rounded-xl border bg-white p-4 text-sm font-medium text-emerald-700 sm:text-lg">已完成 {completed}</p>
          <p className="rounded-xl border bg-white p-4 text-sm font-medium text-amber-700 sm:text-lg">异常 {abnormal}</p>
        </div>
      </section>
      {busy && !visible && <p role="status" className="py-12 text-center text-muted-foreground">加载批量任务…</p>}
      {!busy && !batches.length && !error && <div className="rounded-xl border border-dashed bg-white px-6 py-16 text-center"><p className="font-medium">还没有批量任务</p><p className="mt-2 text-sm text-muted-foreground">添加视频链接，开始第一批笔记。</p></div>}
      <div className="grid gap-4 md:grid-cols-2">
        {batches.map(batch => (
          <Link key={batch.id} to={'/batch/' + encodeURIComponent(batch.id)} className="space-y-5 rounded-xl border bg-white p-5 transition hover:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-ring">
            <div className="flex items-start justify-between gap-3"><h2 className="min-w-0 break-words font-semibold">{batch.name}</h2><span className="shrink-0 rounded-full bg-neutral-100 px-2 py-1 text-xs">{batchLabels[batch.status]}</span></div>
            <p className="text-xs text-muted-foreground">{batch.source_label} · {dateLabel(batch.created_at)}</p>
            <BatchProgress batch={batch} />
          </Link>
        ))}
      </div>
      {!!list && list.total > 20 && <nav aria-label="批次分页" className="flex items-center justify-center gap-4">
        <Button variant="outline" disabled={busy || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</Button>
        <span className="text-sm">{page} / {Math.ceil(list.total / 20)}</span>
        <Button variant="outline" disabled={busy || page * 20 >= list.total} onClick={() => setPage(value => value + 1)}>下一页</Button>
      </nav>}
    </BatchShell>
  )
}
