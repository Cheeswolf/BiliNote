import type { BatchJobStatus, BatchStatus } from './types'

export const jobLabels: Record<BatchJobStatus, string> = {
  PENDING: '等待中', PARSING: '解析中', DOWNLOADING: '下载中', TRANSCRIBING: '转写中',
  SUMMARIZING: '生成中', FORMATTING: '排版中', SAVING: '保存中',
  SUCCESS: '成功', FAILED: '失败', INTERRUPTED: '已中断', CANCELLED: '已取消',
}
export const batchLabels: Record<BatchStatus, string> = {
  PENDING: '等待执行', RUNNING: '处理中', PAUSED: '已暂停', RECOVERABLE: '等待手动继续',
  COMPLETED: '已完成', PARTIAL: '部分异常', CANCELLED: '已取消',
}
export const platformLabel = (platform: string | null) =>
  ({ bilibili: '哔哩哔哩', youtube: 'YouTube', douyin: '抖音', kuaishou: '快手' })[platform ?? ''] ?? platform ?? '未知平台'
export const durationLabel = (seconds: number | null) => {
  if (seconds === null || !Number.isFinite(seconds)) return '时长未知'
  const minutes = Math.floor(seconds / 60)
  return String(minutes).padStart(2, '0') + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')
}
export const dateLabel = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
