export type BatchStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
  | 'RECOVERABLE'
  | 'COMPLETED'
  | 'PARTIAL'
  | 'CANCELLED'
export type BatchJobStatus =
  | 'PENDING'
  | 'PARSING'
  | 'DOWNLOADING'
  | 'TRANSCRIBING'
  | 'SUMMARIZING'
  | 'FORMATTING'
  | 'SAVING'
  | 'SUCCESS'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'CANCELLED'
export type ConnectionStatus = 'online' | 'offline' | 'reconnecting'
export interface BatchPreviewItem {
  original_url: string
  normalized_url: string
  platform: string | null
  resource_key: string
  title: string | null
  cover_url: string | null
  /** Finite and nonnegative when present. */
  duration: number | null
  valid: boolean
  error: string | null
}
export interface BatchSettings {
  quality: 'fast' | 'medium' | 'slow'
  model_name: string
  provider_id: string
  style?: string | null
  format?: string[]
  screenshot?: boolean
  link?: boolean
  extras?: string | null
  video_understanding?: boolean
  video_interval?: number
  /** Empty, or two positive integers. */
  grid_size?: [] | [number, number]
}
export interface BatchSummary {
  id: string
  name: string
  source_label: string
  status: BatchStatus
  created_at: string
  updated_at: string
  total: number
  counts: Record<BatchJobStatus, number>
}
export interface BatchJobSummary {
  task_id: string
  position: number
  original_url: string
  normalized_url: string
  platform: string
  resource_key: string
  title: string | null
  cover_url: string | null
  duration: number | null
  status: BatchJobStatus
  attempt: number
  error_message: string | null
  created_at: string
  updated_at: string
}
export interface BatchDetail extends BatchSummary {
  jobs: BatchJobSummary[]
}
export interface BatchList {
  items: BatchSummary[]
  total: number
  page: number
  page_size: number
}
export interface BatchPreviewRequest {
  lines: string[]
  expand_multipart?: boolean
}
export interface BatchSubmitRequest {
  request_id: string
  name: string
  source_label: string
  items: BatchPreviewItem[]
  settings: BatchSettings
}
export interface BatchSubmitResult {
  batch_id: string
  task_ids: string[]
}
export const isTerminalBatch = (status: BatchStatus) =>
  status === 'COMPLETED' || status === 'PARTIAL' || status === 'CANCELLED'
