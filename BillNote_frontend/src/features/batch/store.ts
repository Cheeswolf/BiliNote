import { create } from 'zustand'
import toast from 'react-hot-toast'
import { readOutcomeReceipts, recordBatchOutcome } from './outcomeReceipts'
import type { OutcomeReceipt } from './outcomeReceipts'
import { batchLabels } from './presentation'
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
  detailRevisions: Record<string, number>
  outcomeReceipts: OutcomeReceipt[] | null
  notifyTerminalOutcome: (detail: BatchDetail) => void
  invalidateDetail: (batchId: string) => void
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
export const useBatchStore = create<BatchStore>((set, get) => ({
  active: null,
  list: null,
  connection: 'online',
  error: null,
  importedTaskIds: {},
  detailRevisions: {},
  outcomeReceipts: null,
  notifyTerminalOutcome: detail => {
    const result = recordBatchOutcome(get().outcomeReceipts ?? readOutcomeReceipts(), detail)
    // Claim synchronously before emitting; StrictMode and other observers share it.
    set({ outcomeReceipts: result.receipts })
    if (!result.notify) return
    const counts = detail.counts
    const message = `批次“${detail.name}”${batchLabels[detail.status]}：成功 ${counts.SUCCESS} / ${detail.total}，失败 ${counts.FAILED}，中断 ${counts.INTERRUPTED}，取消 ${counts.CANCELLED}`
    if (detail.status === 'COMPLETED') toast.success(message)
    else toast(message, { icon: '⚠️' })
  },
  invalidateDetail: batchId => set(state => ({
    active: state.active?.id === batchId ? null : state.active,
    detailRevisions: {
      ...state.detailRevisions,
      [batchId]: (state.detailRevisions[batchId] ?? 0) + 1,
    },
  })),
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
