import { beforeEach, expect, it, vi } from 'vitest'
import { useTaskStore, type Task } from './index'
import { generateNote } from '@/services/note'
vi.mock('@/services/note', () => ({ generateNote: vi.fn(), delete_task: vi.fn() }))
const formData = { video_url: 'https://www.youtube.com/watch?v=abc123', platform: 'youtube', quality: 'medium', model_name: 'model', provider_id: 'provider' }
const original: Task = {
  id: 'source', status: 'SUCCESS', createdAt: '2025-01-01', formData,
  markdown: [{ ver_id: 'original', content: '# Original', created_at: '2025-01-01', style: '', model_name: 'model' }],
  transcript: { full_text: '', language: '', raw: null, segments: [] },
  audioMeta: { cover_url: '', duration: 0, file_path: '', platform: 'youtube', raw_info: null, title: 'Original', video_id: 'abc123' },
}
beforeEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  localStorage.clear()
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [original], currentTaskId: original.id, batchImportedAttempts: {}, recoveryTask: null })
  vi.mocked(generateNote).mockImplementation(async request => ({ task_id: request.task_id! }))
})
it.each([false, true])('regenerates a successful note with independent job identity and linked history (batch: %s)', async batch => {
  if (batch) useTaskStore.setState({ batchImportedAttempts: { source: 0 } })
  await useTaskStore.getState().retryTask('source', formData)
  const current = useTaskStore.getState().getCurrentTask()!
  expect(current.id).not.toBe('source')
  expect(current).toMatchObject({ parentTaskId: 'source', rootTaskId: 'source', status: 'PENDING', markdown: original.markdown })
  expect(useTaskStore.getState().tasks.find(task => task.id === 'source')).toEqual(original)
  expect(generateNote).toHaveBeenCalledWith(expect.objectContaining({ task_id: current.id, parent_task_id: 'source', create_only: true }))
  useTaskStore.getState().updateTaskContent(current.id, { status: 'SUCCESS', markdown: '# New version' })
  expect(useTaskStore.getState().getCurrentTask()?.markdown).toEqual([
    expect.objectContaining({ content: '# New version' }), original.markdown[0],
  ])
})
it('blocks paid submission when history hydration is unavailable', async () => {
  vi.spyOn(useTaskStore.persist, 'hasHydrated').mockReturnValue(false)
  vi.spyOn(useTaskStore.persist, 'rehydrate').mockResolvedValue(undefined)
  await expect(useTaskStore.getState().submitTask(formData)).rejects.toThrow(/storage/)
  expect(generateNote).not.toHaveBeenCalled()
})
it('does not submit an active task again', async () => {
  useTaskStore.setState({ tasks: [{ ...original, status: 'SUMMARIZING' }] })
  await expect(useTaskStore.getState().retryTask('source', formData)).rejects.toThrow()
  expect(generateNote).not.toHaveBeenCalled()
})
it('retries a failed standalone identity as pending and preserves its previous versions', async () => {
  useTaskStore.setState({ tasks: [{ ...original, status: 'FAILED' }] })
  await useTaskStore.getState().retryTask('source', formData)
  expect(useTaskStore.getState().getCurrentTask()).toMatchObject({ id: 'source', status: 'PENDING', markdown: original.markdown })
  expect(generateNote).toHaveBeenCalledWith(expect.objectContaining({ task_id: 'source', create_only: false }))
})

it('waits for hydration before calling the paid endpoint', async () => {
  let hydrated = false
  let release!: () => void
  vi.spyOn(useTaskStore.persist, 'hasHydrated').mockImplementation(() => hydrated)
  vi.spyOn(useTaskStore.persist, 'rehydrate').mockImplementation(() => new Promise<void>(resolve => {
    release = () => { hydrated = true; resolve() }
  }))
  const submission = useTaskStore.getState().submitTask(formData)
  await Promise.resolve()
  expect(generateNote).not.toHaveBeenCalled()
  release()
  await submission
  expect(useTaskStore.getState().getCurrentTask()?.status).toBe('PENDING')
  expect(generateNote).toHaveBeenCalledTimes(1)
})
it('retains the confirmed task and recovery ID if persistence fails, and saving recovery never submits again', async () => {
  const storage = useTaskStore.persist.getOptions().storage!
  const write = vi.spyOn(storage, 'setItem').mockRejectedValueOnce(new Error('disk full'))
  await useTaskStore.getState().submitTask(formData)
  const recovery = useTaskStore.getState().recoveryTask!
  expect(recovery.id).toBeTruthy()
  expect(useTaskStore.getState().getCurrentTask()?.id).toBe(recovery.id)
  expect(localStorage.getItem('single-task-recovery')).toContain(recovery.id)
  write.mockRestore()
  await useTaskStore.getState().saveRecoveredTask()
  expect(useTaskStore.getState().recoveryTask).toBeNull()
  expect(generateNote).toHaveBeenCalledTimes(1)
  await useTaskStore.persist.rehydrate()
  expect(useTaskStore.getState().tasks.some(task => task.id === recovery.id)).toBe(true)
})

it('restores a confirmed retry receipt after module reload instead of the stale failed history record', async () => {
  useTaskStore.setState({ tasks: [{ ...original, status: 'FAILED' }] })
  const write = vi.spyOn(useTaskStore.persist.getOptions().storage!, 'setItem').mockRejectedValueOnce(new Error('disk full'))
  await useTaskStore.getState().retryTask('source', formData)
  write.mockRestore()
  vi.resetModules()
  const { useTaskStore: restarted } = await import('./index')
  await restarted.persist.rehydrate()
  expect(restarted.getState().recoveryTask?.id).toBe('source')
  expect(restarted.getState().getCurrentTask()?.status).toBe('FAILED')
  await restarted.getState().saveRecoveredTask()
  expect(restarted.getState().getCurrentTask()).toMatchObject({ id: 'source', status: 'PENDING', createdAt: original.createdAt })
  expect(generateNote).toHaveBeenCalledTimes(1)
})


it('restores a newly confirmed task after reload without another creation request', async () => {
  const write = vi.spyOn(useTaskStore.persist.getOptions().storage!, 'setItem').mockRejectedValueOnce(new Error('disk full'))
  await useTaskStore.getState().submitTask(formData)
  const confirmedId = useTaskStore.getState().recoveryTask!.id
  write.mockRestore()
  vi.resetModules()
  const { useTaskStore: restarted } = await import('./index')
  await restarted.persist.rehydrate()
  expect(restarted.getState().tasks.some(task => task.id === confirmedId)).toBe(false)
  expect(restarted.getState().recoveryTask?.id).toBe(confirmedId)
  await restarted.getState().saveRecoveredTask()
  expect(restarted.getState().getCurrentTask()).toMatchObject({ id: confirmedId, status: 'PENDING' })
  expect(restarted.getState().recoveryTask).toBeNull()
  expect(generateNote).toHaveBeenCalledTimes(1)
})
