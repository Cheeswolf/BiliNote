import { create } from 'zustand'
import { ResultUnavailableError } from '@/utils/polling'
import { get_task_status } from '@/services/note'
import { useTaskStore } from '@/store/taskStore'
import type { BatchDetail, BatchJobSummary, BatchList, ConnectionStatus } from './types'

interface BatchStore {
  active: BatchDetail | null
  list: BatchList | null
  connection: ConnectionStatus
  error: string | null
  importedTaskIds: Record<string, true>
  setActive: (detail: BatchDetail | null) => void
  setList: (list: BatchList) => void
  setConnection: (connection: ConnectionStatus) => void
  importSuccessfulTasks: (detail: BatchDetail) => Promise<void>
}
// Shared across callers so concurrent hooks or refreshes cannot import twice.
const importing = new Map<string, Promise<void>>()
let hydration: Promise<void> | undefined
const hydrateHistory = async () => {
  if (useTaskStore.persist.hasHydrated()) return
  hydration ??= Promise.resolve(useTaskStore.persist.rehydrate()).finally(() => {
    hydration = undefined
  })
  await hydration
}
const importJob = async (job: BatchJobSummary) => {
  await hydrateHistory()
  if (useBatchStore.getState().importedTaskIds[job.task_id]) return
  if (
    useTaskStore.getState().tasks.some(task => task.id === job.task_id && task.status === 'SUCCESS')
  ) {
    useBatchStore.setState(state => ({
      importedTaskIds: { ...state.importedTaskIds, [job.task_id]: true },
    }))
    return
  }
  const existing = importing.get(job.task_id)
  if (existing) return existing
  const pending = (async () => {
    const response = await get_task_status(job.task_id, { suppressToast: true })
    if (response.status !== 'SUCCESS' || !response.result)
      throw new ResultUnavailableError(
        response.message || 'Successful note result is not available yet'
      )
    const { markdown, transcript, audio_meta } = response.result
    useTaskStore.getState().importCompletedTask({
      id: job.task_id,
      status: 'SUCCESS',
      createdAt: job.created_at,
      markdown:
        typeof markdown === 'string'
          ? [
              {
                ver_id: job.task_id + '-batch',
                content: markdown,
                style: '',
                model_name: '',
                created_at: job.updated_at,
              },
            ]
          : markdown,
      transcript,
      audioMeta: {
        cover_url: audio_meta.cover_url ?? job.cover_url ?? '',
        duration: audio_meta.duration ?? job.duration ?? 0,
        title: audio_meta.title ?? job.title ?? '',
        file_path: audio_meta.file_path ?? '',
        raw_info: audio_meta.raw_info ?? null,
        video_id: audio_meta.video_id ?? '',
        platform: audio_meta.platform || job.platform,
      },
      platform: job.platform,
      // The lightweight batch API deliberately excludes the settings snapshot.
      formData: {
        video_url: job.normalized_url,
        platform: job.platform,
        quality: '',
        model_name: '',
        provider_id: '',
        format: [],
        grid_size: [],
        style: '',
      },
    })
    useBatchStore.setState(state => ({
      importedTaskIds: { ...state.importedTaskIds, [job.task_id]: true },
    }))
  })()
  importing.set(job.task_id, pending)
  try {
    await pending
  } finally {
    importing.delete(job.task_id)
  }
}
export const useBatchStore = create<BatchStore>(set => ({
  active: null,
  list: null,
  connection: 'online',
  error: null,
  importedTaskIds: {},
  setActive: active => set({ active }),
  setList: list => set({ list }),
  setConnection: connection => set({ connection }),
  importSuccessfulTasks: async detail => {
    // All successes get a chance even when one result is temporarily unavailable.
    const results = await Promise.allSettled(
      detail.jobs.filter(job => job.status === 'SUCCESS').map(importJob)
    )
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  },
}))
