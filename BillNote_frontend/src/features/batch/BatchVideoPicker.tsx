import { Button } from '@/components/ui/button'
import { Film, X } from 'lucide-react'
import type { BatchPreviewItem } from './types'
import { durationLabel, platformLabel } from './presentation'
export interface PickerRow {
  id: string
  item: BatchPreviewItem
  selected: boolean
}
export default function BatchVideoPicker({ rows, onChange }: {
  rows: PickerRow[]
  onChange: (rows: PickerRow[]) => void
}) {
  const selected = rows.filter(row => row.selected && row.item.valid).length
  const invalidCount = rows.filter(row => !row.item.valid).length
  return (
    <section className="space-y-4" aria-label="视频选择">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm" aria-live="polite">已选择 <strong>{selected}</strong> / 100 条 · 共 {rows.length} 项</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => onChange(rows.map(row => ({ ...row, selected: row.item.valid })))}>全选</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange(rows.map(row => ({ ...row, selected: row.item.valid && !row.selected })))}>反选</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => onChange(rows.map(row => ({ ...row, selected: false })))}>清空选择</Button>
          <Button type="button" size="sm" variant="outline" disabled={!invalidCount} onClick={() => onChange(rows.filter(row => row.item.valid))}>移除无效项</Button>
        </div>
      </div>
      {selected > 100 && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">每批最多选择 100 条视频，请减少选择后继续。</p>}
      <div className="max-h-[32rem] divide-y overflow-y-auto rounded-xl border bg-white">
        {rows.map(({ id, item, selected }, position) => {
          const title = item.title || item.original_url
          return (
            <article key={id} className={'flex items-center gap-3 p-4 ' + (!item.valid ? 'bg-red-50/50' : '')}>
              <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" aria-label={'选择 ' + title}
                disabled={!item.valid} checked={selected && item.valid}
                onChange={e => onChange(rows.map(row => row.id === id ? { ...row, selected: e.target.checked } : row))} />
              <span className="w-6 shrink-0 text-center text-xs text-muted-foreground">{position + 1}</span>
              {item.cover_url ? <img src={item.cover_url} alt={title} loading="lazy" referrerPolicy="no-referrer"
                className="hidden h-16 w-28 shrink-0 rounded-md bg-neutral-100 object-cover sm:block" />
                : <div className="hidden h-16 w-28 shrink-0 items-center justify-center rounded-md bg-neutral-100 sm:flex"><Film className="h-6 w-6 text-neutral-400" /></div>}
              <div className="min-w-0 flex-1 space-y-1">
                <p className="break-words text-sm font-medium">{title}</p>
                <p className="flex flex-wrap gap-3 text-xs text-muted-foreground"><span>{platformLabel(item.platform)}</span><span>{durationLabel(item.duration)}</span></p>
                <p className="truncate text-xs text-muted-foreground" title={item.normalized_url || item.original_url}>{item.normalized_url || item.original_url}</p>
                {!item.valid && <p className="text-xs text-red-700">{item.error || '链接无效'}</p>}
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label={'移除 ' + title} onClick={() => onChange(rows.filter(row => row.id !== id))}><X className="h-4 w-4" /></Button>
            </article>
          )
        })}
      </div>
    </section>
  )
}
