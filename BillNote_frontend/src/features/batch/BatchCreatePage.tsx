import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useModelStore } from '@/store/modelStore'
import { pollingErrorMessage } from '@/utils/polling'
import { generationDefaults, generationSettingsSchema } from '@/pages/HomePage/components/generationSettingsSchema'
import { previewBatch, submitBatch } from './api'
import { useBatchStore } from './store'
import type { BatchSubmitRequest } from './types'
import BatchShell from './BatchShell'
import BatchSettings from './BatchSettings'
import BatchVideoPicker, { type PickerRow } from './BatchVideoPicker'

const batchSettingsSchema = generationSettingsSchema.extend({
  video_interval: generationSettingsSchema.shape.video_interval.unwrap().int('采样间隔需为整数秒').optional(),
})

export default function BatchCreatePage() {
  const navigate = useNavigate()
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const models = useModelStore(state => state.modelList)
  const [step, setStep] = useState(1)
  const [lines, setLines] = useState('')
  const [rows, setRows] = useState<PickerRow[]>([])
  const [name, setName] = useState('批量视频笔记')
  const [settings, setSettings] = useState(() => generationDefaults(models[0]?.model_name))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  // Freeze the exact payload after first submit; uncertain retries must keep its idempotency key.
  const attempt = useRef<BatchSubmitRequest | null>(null)
  const selected = rows.filter(row => row.item.valid && row.selected).map(row => row.item)
  const selectionValid = selected.length > 0 && selected.length <= 100
  const model = models.find(m => m.model_name === settings.model_name && (!settings.provider_id || m.provider_id === settings.provider_id))
  const validation = batchSettingsSchema.safeParse(settings)
  const canSubmit = selectionValid && !!name.trim() && !!model && validation.success
  const parse = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setRows([])
    try {
      const result = await previewBatch({ lines: lines.split(/\r?\n/).map(line => line.trim()).filter(Boolean), expand_multipart: true })
      setRows(result.items.map(item => ({ id: uuid(), item, selected: item.valid })))
    } catch (error) {
      if (!mounted.current) return
      setError(pollingErrorMessage(error))
    } finally { if (mounted.current) setBusy(false) }
  }
  const submit = async () => {
    if (busy || (!attempt.current && !canSubmit)) return
    if (!attempt.current && model) {
      attempt.current = {
        request_id: uuid(), name: name.trim(), source_label: '视频链接',
        items: selected, settings: { ...settings, provider_id: model.provider_id },
      }
    }
    if (!attempt.current) return
    setSubmitted(true)
    setBusy(true)
    setError(null)
    try {
      const result = await submitBatch(attempt.current)
      // A confirmed server batch remains ours after navigation, even if submit was slow.
      useBatchStore.getState().trackSubmittedBatch(result.batch_id)
      if (!mounted.current) return
      navigate('/batch/' + encodeURIComponent(result.batch_id), { replace: true })
    } catch (error) {
      if (!mounted.current) return
      setError(pollingErrorMessage(error))
      // A confirmed request validation rejection created nothing; permit correction.
      // Transport failures and server failures keep the frozen attempt for safe retry.
      if (typeof error === 'object' && error !== null && (
        ('code' in error && (error.code === 400 || error.code === 422)) ||
        ('status' in error && (error.status === 400 || error.status === 422))
      )) {
        attempt.current = null
        setSubmitted(false)
      }
    } finally { if (mounted.current) setBusy(false) }
  }
  return (
    <BatchShell key={step} actions={step === 1 ? (
      <>
        <p className="mr-auto text-sm text-muted-foreground">已选择 {selected.length} / 100 条</p>
        <Button disabled={!selectionValid || busy} onClick={() => { setStep(2); setError(null) }}>下一步<ArrowRight className="h-4 w-4" /></Button>
      </>
    ) : (
      <>
        <Button type="button" variant="outline" disabled={submitted} onClick={() => setStep(1)}>上一步</Button>
        <Button type="submit" form="batch-create-form" disabled={busy || (!submitted && !canSubmit)}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}{submitted && error ? '重试提交' : '开始生成 ' + selected.length + ' 条笔记'}
        </Button>
      </>
    )}>
      <Link to="/batch" className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft className="h-4 w-4" />批量任务中心</Link>
      <div><h1 className="text-2xl font-semibold">新建批量任务</h1><p className="mt-2 text-sm text-muted-foreground">选择视频，统一设置，按顺序逐条生成独立笔记。</p></div>
      <ol className="flex gap-6 border-b pb-4 text-sm" aria-label="创建步骤">
        <li aria-current={step === 1 ? 'step' : undefined} className={step === 1 ? 'font-semibold text-primary' : 'text-muted-foreground'}>1 · 选择视频</li>
        <li aria-current={step === 2 ? 'step' : undefined} className={step === 2 ? 'font-semibold text-primary' : 'text-muted-foreground'}>2 · 生成设置</li>
      </ol>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}{submitted && <p className="mt-2">提交结果尚未确认。重试会查询或创建同一批次，当前视频与设置已保留。</p>}</div>}
      {step === 1 ? (
        <div className="space-y-6">
          <div className="space-y-3 rounded-xl border bg-white p-5">
            <label htmlFor="batch-links" className="text-sm font-medium">视频链接</label>
            <Textarea id="batch-links" rows={6} value={lines} disabled={busy}
              placeholder={'每行一个视频链接\n支持 B 站、YouTube、抖音、快手'}
              onChange={e => { setLines(e.target.value); setRows([]); setError(null) }} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">B 站分 P 自动展开，可逐集勾选。每批最多 100 条。</p>
              <Button disabled={busy || !lines.trim()} onClick={() => { void parse() }}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}解析链接</Button>
            </div>
          </div>
          {!!rows.length && <BatchVideoPicker rows={rows} onChange={setRows} />}
        </div>
      ) : (
        <form id="batch-create-form" className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]" onSubmit={e => { e.preventDefault(); void submit() }}>
          <div className="space-y-6 rounded-xl border bg-white p-5 sm:p-6">
            <label className="block space-y-2 text-sm font-medium">批次名称
              <Input value={name} maxLength={200} required disabled={submitted} onChange={e => setName(e.target.value)} />
            </label>
            <BatchSettings value={settings} onChange={setSettings} disabled={submitted} />
            {!validation.success && <p role="alert" className="text-sm text-red-700">{validation.error.issues[0].message}</p>}
          </div>
          <aside className="space-y-5 rounded-xl border bg-white p-5 lg:sticky lg:top-6">
            <div><p className="text-sm text-muted-foreground">本次生成</p><p className="mt-1 text-3xl font-semibold">{selected.length}<span className="ml-2 text-sm font-normal">条笔记</span></p></div>
            <p className="text-sm leading-6 text-muted-foreground">每个视频生成一篇笔记，使用相同设置并按选择列表顺序执行。单条失败会继续下一条。</p>
          </aside>
        </form>
      )}
    </BatchShell>
  )
}
