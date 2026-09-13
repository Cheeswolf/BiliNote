import { create } from 'zustand'
import { ResultUnavailableError, TaskStorageError } from '@/utils/polling'
import { get_task_status } from '@/services/note'
import { ensureTaskHistoryHydrated, useTaskStore } from '@/store/taskStore'
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
// Serialize result retrieval across all batch callers, including overlapping mounts.
let importQueue: Promise<void> = Promise.resolve()
const importJob = async (job: BatchJobSummary) => {
  await ensureTaskHistoryHydrated()
  if (useBatchStore.getState().importedTaskIds[job.task_id]) return
  if (
    useTaskStore.getState().tasks.some(task => task.id === job.task_id && task.status === 'SUCCESS')
  ) {
    useBatchStore.setState(state => ({
      importedTaskIds: { ...state.importedTaskIds, [job.task_id]: true },
    }))
    return
  }
  {
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
  importSuccessfulTasks: detail => {
    const next = importQueue.then(async () => {
      const failures: unknown[] = []
      for (const job of detail.jobs) {
        if (job.status !== 'SUCCESS') continue
        try {
          await importJob(job)
        } catch (error) {
          // Storage failure affects all imports; wait for recovery before any history write.
          if (error instanceof TaskStorageError) throw error
          failures.push(error)
        }
      }
      if (failures.length) throw failures[0]
    })
    importQueue = next.catch(() => {})
    return next
  },
}))
