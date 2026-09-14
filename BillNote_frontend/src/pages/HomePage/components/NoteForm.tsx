import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, Plus } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { generateNote } from '@/services/note'
import { uploadFile } from '@/services/upload'
import { useTaskStore } from '@/store/taskStore'
import { useModelStore } from '@/store/modelStore'
import { videoPlatforms } from '@/constant/note'
import GenerationSettings from './GenerationSettings'
import { generationDefaults, generationSettingsSchema, type GenerationSettingsValues } from './generationSettingsSchema'

const formSchema = generationSettingsSchema.extend({
  video_url: z.string().optional(),
  platform: z.string().min(1, '请选择平台'),
}).superRefine(({ video_url, platform }, ctx) => {
  if (!video_url) {
    ctx.addIssue({ code: 'custom', message: platform === 'local' ? '本地视频路径不能为空' : '视频链接不能为空', path: ['video_url'] })
  } else if (platform !== 'local') {
    try {
      if (!['http:', 'https:'].includes(new URL(video_url).protocol)) throw new Error()
    } catch {
      ctx.addIssue({ code: 'custom', message: '请输入正确的视频链接', path: ['video_url'] })
    }
  }
})
export type NoteFormValues = z.infer<typeof formSchema>

export default function NoteForm() {
  const navigate = useNavigate()
  const [isUploading, setIsUploading] = useState(false)
  const [uploadSuccess, setUploadSuccess] = useState(false)
  const { addPendingTask, currentTaskId, setCurrentTask, tasks, retryTask } = useTaskStore()
  const models = useModelStore(state => state.modelList)
  const loadModels = useModelStore(state => state.loadEnabledModels)
  const currentTask = tasks.find(task => task.id === currentTaskId)
  const formData = currentTask?.formData
  const firstModel = models[0]?.model_name || ''
  const form = useForm<NoteFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { platform: 'bilibili', ...generationDefaults(firstModel) },
  })
  const values = form.watch()
  const editing = !!currentTask
  const generating = !!currentTask && !['SUCCESS', 'FAILED', 'INTERRUPTED', 'CANCELLED'].includes(currentTask.status)
  useEffect(() => { void loadModels() }, [loadModels])
  useEffect(() => {
    if (!formData) return
    // Older history used video_understand; actual generation requests use video_understanding.
    const saved = formData as typeof formData & { video_understanding?: boolean }
    form.reset({
      platform: saved.platform || 'bilibili',
      video_url: saved.video_url || '',
      model_name: saved.model_name || firstModel,
      style: saved.style || 'minimal',
      quality: saved.quality === 'fast' || saved.quality === 'slow' ? saved.quality : 'medium',
      extras: saved.extras || '',
      screenshot: saved.screenshot ?? false,
      link: saved.link ?? false,
      video_understanding: saved.video_understanding ?? saved.video_understand ?? false,
      video_interval: saved.video_interval ?? 6,
      grid_size: saved.grid_size?.length === 2 ? [saved.grid_size[0], saved.grid_size[1]] : [2, 2],
      format: saved.format ?? [],
    })
  }, [formData, currentTaskId, firstModel, form])
  const updateSettings = (patch: Partial<GenerationSettingsValues>) => {
    for (const key of Object.keys(patch) as (keyof GenerationSettingsValues)[]) {
      form.setValue(key, patch[key], { shouldDirty: true, shouldValidate: form.formState.isSubmitted })
    }
  }
  const handleFileUpload = async (file: File, onChange: (url: string) => void) => {
    const data = new FormData()
    data.append('file', file)
    setIsUploading(true)
    setUploadSuccess(false)
    try {
      const result = await uploadFile(data)
      onChange(result.url)
      setUploadSuccess(true)
    } catch (error) { console.error('上传失败:', error) }
    finally { setIsUploading(false) }
  }
  const onSubmit = async (values: NoteFormValues) => {
    const model = models.find(m => m.model_name === values.model_name && (!values.provider_id || m.provider_id === values.provider_id))
    if (!model) {
      form.setError('model_name', { message: '请选择可用模型' })
      return
    }
    const payload = {
      ...values, video_url: values.video_url || '', grid_size: values.grid_size ?? [2, 2],
      provider_id: model.provider_id, task_id: currentTaskId || '',
    }
    if (currentTaskId) {
      await retryTask(currentTaskId, payload)
      return
    }
    try {
      const data = await generateNote(payload)
      if (data) addPendingTask(data.task_id, values.platform, payload)
    } catch (cause: unknown) {
      const error = cause as { data?: { reason?: string; downloading?: boolean } }
      if (error?.data?.reason === 'transcriber_model_not_ready') {
        const downloading = error.data.downloading
        toast.error(downloading ? '转写模型正在下载中，请稍候再提交' : '转写模型尚未下载，请先去「音频转写配置」页下载')
        if (!downloading) navigate('/settings/transcriber')
        return
      }
      console.error('提交任务失败：', cause)
    }
  }
  const settingsError = Object.entries(form.formState.errors).find(([key]) => key !== 'video_url' && key !== 'platform')?.[1]
  return (
    <div className="h-full w-full">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="flex gap-2">
            <Button type="submit" className={editing ? 'w-2/3' : 'w-full'} disabled={generating}>
              {generating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {generating ? '正在生成…' : editing ? '重新生成' : '生成笔记'}
            </Button>
            {editing && <Button type="button" variant="outline" className="w-1/3" onClick={() => setCurrentTask(null)}><Plus className="mr-2 h-4 w-4" />新建笔记</Button>}
          </div>
          <h2 className="text-sm font-medium">视频链接</h2>
          <div className="flex gap-2">
            <FormField control={form.control} name="platform" render={({ field }) => (
              <FormItem>
                <Select disabled={editing} value={field.value} onValueChange={field.onChange}>
                  <FormControl><SelectTrigger className="w-32" aria-label="视频平台"><SelectValue /></SelectTrigger></FormControl>
                  <SelectContent>{videoPlatforms.map(platform => <SelectItem key={platform.value} value={platform.value}>
                    <div className="flex items-center gap-2"><div className="h-4 w-4">{platform.logo()}</div><span>{platform.label}</span></div>
                  </SelectItem>)}</SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="video_url" render={({ field }) => (
              <FormItem className="min-w-0 flex-1">
                <FormControl><Input disabled={editing} {...field} value={field.value ?? ''} placeholder={values.platform === 'local' ? '请输入本地视频路径' : '请输入视频网站链接'} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </div>
          {values.platform === 'local' && <FormField control={form.control} name="video_url" render={({ field }) => (
            <FormItem>
              <button type="button" disabled={editing || isUploading}
                className="flex h-40 w-full items-center justify-center rounded-md border-2 border-dashed border-gray-300 text-sm text-muted-foreground hover:border-primary disabled:opacity-50"
                onDragOver={e => { e.preventDefault(); e.stopPropagation() }}
                onDrop={e => {
                  e.preventDefault()
                  if (editing || isUploading) return
                  const file = e.dataTransfer.files?.[0]
                  if (file) void handleFileUpload(file, field.onChange)
                }}
                onClick={() => {
                  const input = document.createElement('input')
                  input.type = 'file'
                  input.accept = 'video/*'
                  input.onchange = () => {
                    const file = input.files?.[0]
                    if (file) void handleFileUpload(file, field.onChange)
                  }
                  input.click()
                }}>
                {isUploading ? '上传中，请稍候…' : uploadSuccess ? '上传成功！' : '拖拽文件到这里上传，或点击选择文件'}
              </button>
            </FormItem>
          )} />}
          <GenerationSettings value={values} onChange={updateSettings} models={models}
            platform={values.platform} onRefreshModels={() => { void loadModels() }} />
          {settingsError && <p role="alert" className="text-sm text-red-700">{settingsError.message || '请检查生成设置'}</p>}
        </form>
      </Form>
    </div>
  )
}
