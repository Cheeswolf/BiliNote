import type { BatchSummary } from './types'
export default function BatchProgress({ batch }: { batch: BatchSummary }) {
  const counts = batch.counts
  const finished = counts.SUCCESS + counts.FAILED + counts.CANCELLED
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span>已结束 {finished} / {batch.total}</span>
        <span className="text-muted-foreground">成功 {counts.SUCCESS} / {batch.total}</span>
      </div>
      <progress aria-label="批次进度" aria-valuemin={0} aria-valuemax={batch.total} aria-valuenow={finished}
        value={finished} max={Math.max(1, batch.total)} className="h-2 w-full overflow-hidden rounded-full accent-primary" />
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <span className="text-emerald-700">成功 {counts.SUCCESS}</span>
        <span className="text-red-700">失败 {counts.FAILED}</span>
        <span className="text-neutral-600">等待 {counts.PENDING}</span>
        <span className="text-amber-700">中断 {counts.INTERRUPTED}</span>
        {!!counts.CANCELLED && <span className="text-neutral-500">取消 {counts.CANCELLED}</span>}
      </div>
    </div>
  )
}
