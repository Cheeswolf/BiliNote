import type { BatchDetail, BatchJobStatus } from './types'
export const detailWithJob = (
  status: BatchJobStatus = 'SUMMARIZING',
  id = 'batch-1'
): BatchDetail => ({
  id,
  name: 'Lecture notes',
  source_label: 'links',
  status: 'RUNNING',
  created_at: '2026-09-10T10:00:00',
  updated_at: '2026-09-10T10:00:01',
  total: 1,
  counts: {
    PENDING: 0,
    PARSING: 0,
    DOWNLOADING: 0,
    TRANSCRIBING: 0,
    SUMMARIZING: 0,
    FORMATTING: 0,
    SAVING: 0,
    SUCCESS: 0,
    FAILED: 0,
    INTERRUPTED: 0,
    CANCELLED: 0,
    [status]: 1,
  },
  jobs: [
    {
      task_id: 'task-1',
      position: 0,
      original_url: 'https://youtu.be/abc',
      normalized_url: 'https://www.youtube.com/watch?v=abc',
      platform: 'youtube',
      resource_key: 'youtube:abc',
      title: 'Lecture',
      cover_url: null,
      duration: null,
      status,
      attempt: 1,
      error_message: null,
      created_at: '2026-09-10T10:00:00',
      updated_at: '2026-09-10T10:00:01',
    },
  ],
})
export const successfulResult = {
  task_id: 'task-1',
  status: 'SUCCESS' as const,
  message: '',
  result: {
    markdown: '# Imported lecture',
    transcript: { full_text: 'Lecture text', language: 'en', raw: null, segments: [] },
    audio_meta: {
      title: 'Result title',
      cover_url: 'cover.jpg',
      duration: 42,
      file_path: '',
      platform: 'youtube',
      raw_info: null,
      video_id: 'abc',
    },
  },
}
