import { useId } from 'react'
import { Link } from 'react-router-dom'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { noteFormats, noteStyles } from '@/constant/note'
import type { EnabledModel } from '@/services/model'
import type { GenerationSettingsValues } from './generationSettingsSchema'

interface Props {
  value: GenerationSettingsValues
  onChange: (patch: Partial<GenerationSettingsValues>) => void
  models: EnabledModel[]
  onRefreshModels: () => void
  platform?: string
  disabled?: boolean
}
const selectClass = 'mt-2 h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50'

export default function GenerationSettings({
  value, onChange, models, onRefreshModels, platform, disabled = false,
}: Props) {
  const id = useId()
  const model = models.find(m =>
    m.model_name === value.model_name && (!value.provider_id || m.provider_id === value.provider_id)
  )
  return (
    <fieldset disabled={disabled} className="space-y-5">
      <legend className="sr-only">生成设置</legend>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={id + '-model'} className="text-sm font-medium">模型选择</label>
          {models.length ? (
            <select id={id + '-model'} className={selectClass} value={model ? String(model.id) : ''}
              onFocus={onRefreshModels}
              onChange={e => {
                const next = models.find(m => String(m.id) === e.target.value)
                if (next) onChange({ model_name: next.model_name, provider_id: next.provider_id })
              }}>
              <option value="" disabled>请选择模型</option>
              {models.map(m => <option key={m.id} value={m.id}>
                {m.model_name}{models.some(other => other.id !== m.id && other.model_name === m.model_name) ? ' · ' + m.provider_id : ''}
              </option>)}
            </select>
          ) : <Link className="mt-2 block rounded-md border p-2 text-sm text-primary" to="/settings/model">请先添加模型</Link>}
        </div>
        <label className="text-sm font-medium">笔记风格
          <select className={selectClass} value={value.style} onChange={e => onChange({ style: e.target.value })}>
            {noteStyles.map(style => <option key={style.value} value={style.value}>{style.label}</option>)}
          </select>
        </label>
      </div>
      <label className="block text-sm font-medium">音频质量
        <select className={selectClass} value={value.quality}
          onChange={e => onChange({ quality: e.target.value as GenerationSettingsValues['quality'] })}>
          <option value="fast">快速</option><option value="medium">均衡</option><option value="slow">高质量</option>
        </select>
      </label>
      <section className="space-y-3 rounded-lg border bg-muted/20 p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={value.video_understanding ?? false}
            onChange={e => onChange({ video_understanding: e.target.checked })} />
          启用视频理解
        </label>
        <p className="text-xs text-muted-foreground">将视频截图交给多模态模型辅助分析。此功能需要支持图像的模型。</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-2 text-sm">采样间隔（秒）
            <Input type="number" min={1} max={30} step="any" value={value.video_interval ?? 6}
              disabled={!value.video_understanding} onChange={e => onChange({ video_interval: Number(e.target.value) })} />
          </label>
          <div className="space-y-2 text-sm">
            <span>拼图尺寸（列 × 行）</span>
            <div className="flex items-center gap-2">
              <Input aria-label="拼图列数" type="number" min={1} max={10} step={1}
                disabled={!value.video_understanding} value={value.grid_size?.[0] ?? 2}
                onChange={e => onChange({ grid_size: [Number(e.target.value), value.grid_size?.[1] ?? 2] })} />
              <span>×</span>
              <Input aria-label="拼图行数" type="number" min={1} max={10} step={1}
                disabled={!value.video_understanding} value={value.grid_size?.[1] ?? 2}
                onChange={e => onChange({ grid_size: [value.grid_size?.[0] ?? 2, Number(e.target.value)] })} />
            </div>
          </div>
        </div>
      </section>
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">笔记格式</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-3">
          {noteFormats.map(({ label, value: format }) => (
            <label key={format} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-primary"
                checked={value.format.includes(format)}
                disabled={(format === 'link' && platform === 'local') || (format === 'screenshot' && !value.video_understanding)}
                onChange={e => onChange({
                  format: e.target.checked ? [...value.format, format] : value.format.filter(v => v !== format),
                })} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block space-y-2 text-sm font-medium">备注
        <Textarea value={value.extras ?? ''} placeholder="笔记需要罗列出 xxx 关键点…"
          onChange={e => onChange({ extras: e.target.value })} />
      </label>
    </fieldset>
  )
}
