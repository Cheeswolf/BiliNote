import request from '@/utils/request'
import toast from 'react-hot-toast'
import type { AudioMeta, Markdown, TaskStatus, Transcript } from '@/store/taskStore'

export const generateNote = async (data: {
  video_url: string
  platform: string
  quality: string
  model_name: string
  provider_id: string
  task_id?: string
  format: Array<string>
  style: string
  extras?: string
  video_understand?: boolean
  video_interval?: number
  grid_size: Array<number>
}) => {
  try {
    console.log('generateNote', data)
    const response = await request.post('/generate_note', data)

    if (!response) return null
    toast.success('笔记生成任务已提交！')

    console.log('res', response)
    // 成功提示

    return response
  } catch (e: unknown) {
    console.error('❌ 请求出错', e)

    // 错误提示
    // toast.error('笔记生成失败，请稍后重试')

    throw e // 抛出错误以便调用方处理
  }
}

export const delete_task = async ({
  video_id,
  platform,
}: {
  video_id: string
  platform: string
}) => {
  try {
    const data = {
      video_id,
      platform,
    }
    const res = await request.post('/delete_task', data)

    toast.success('任务已成功删除')
    return res
  } catch (e) {
    toast.error('请求异常，删除任务失败')
    console.error('❌ 删除任务失败:', e)
    throw e
  }
}

export interface TaskStatusResponse {
  status: TaskStatus
  task_id: string
  message?: string
  result?: {
    markdown: string | Markdown[]
    transcript: Transcript
    audio_meta: Omit<AudioMeta, 'cover_url'> & { cover_url: string | null }
  }
}

export const get_task_status = (task_id: string, options: { suppressToast?: boolean } = {}) =>
  request.get<unknown, TaskStatusResponse>('/task_status/' + encodeURIComponent(task_id), options)
