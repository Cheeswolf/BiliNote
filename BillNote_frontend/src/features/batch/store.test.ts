import { beforeEach, describe, expect, it, vi } from 'vitest'
import { set as setItem } from 'idb-keyval'
import { useTaskStore } from '@/store/taskStore'
import { get_task_status } from '@/services/note'
import { useBatchStore } from './store'
import { detailWithJob, successfulResult } from './testFixtures'
vi.mock('@/services/note', () => ({
  get_task_status: vi.fn(),
  generateNote: vi.fn(),
  delete_task: vi.fn(),
}))
const getResult = vi.mocked(get_task_status)
beforeEach(async () => {
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], currentTaskId: null, connections: {} })
  useBatchStore.setState(useBatchStore.getInitialState(), true)
})
describe('batch imports', () => {
  it('imports concurrent successful results exactly once by task_id without changing selection', async () => {
    getResult.mockResolvedValue(successfulResult)
    useTaskStore.setState({ currentTaskId: 'selected-note' })
    await Promise.all([
      useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS')),
      useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS')),
    ])
    await useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
    expect(useTaskStore.getState().tasks).toHaveLength(1)
    expect(useTaskStore.getState().tasks[0]).toMatchObject({
      id: 'task-1',
      status: 'SUCCESS',
      markdown: [{ content: '# Imported lecture' }],
      audioMeta: { title: 'Result title', duration: 42 },
      formData: { video_url: 'https://www.youtube.com/watch?v=abc' },
    })
    expect(useTaskStore.getState().currentTaskId).toBe('selected-note')
    expect(getResult).toHaveBeenCalledTimes(1)
  })
  it('deduplicates against hydrated history and preserves existing markdown versions', async () => {
    getResult.mockResolvedValue(successfulResult)
    await useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
    const existing = useTaskStore.getState().tasks[0]
    useBatchStore.setState(useBatchStore.getInitialState(), true)
    await useTaskStore.persist.rehydrate()
    await useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
    expect(useTaskStore.getState().tasks).toEqual([existing])
    expect(getResult).toHaveBeenCalledTimes(1)
  })
  it('retries result retrieval after a network failure without importing an empty note', async () => {
    getResult.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(successfulResult)
    await expect(
      useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
    ).rejects.toThrow('offline')
    expect(useTaskStore.getState().tasks).toEqual([])
    await useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
    expect(useTaskStore.getState().tasks).toHaveLength(1)
  })
  it('rejects SUCCESS without a result so it remains eligible for import', async () => {
    getResult.mockResolvedValueOnce({
      status: 'SUCCESS',
      task_id: 'task-1',
      message: 'missing result',
    })
    await expect(
      useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
    ).rejects.toThrow()
    expect(useTaskStore.getState().tasks).toEqual([])
  })
  it('normalizes legacy FAILD history without discarding selection or note content', async () => {
    await setItem(
      'task-storage',
      JSON.stringify({
        version: 0,
        state: {
          tasks: [
            {
              id: 'old',
              status: 'FAILD',
              markdown: 'old note',
              createdAt: '2025-01-01',
              formData: { style: 'old' },
            },
          ],
          currentTaskId: 'old',
        },
      })
    )
    await useTaskStore.persist.rehydrate()
    expect(useTaskStore.getState().tasks[0]).toMatchObject({
      id: 'old',
      status: 'FAILED',
      markdown: 'old note',
    })
    expect(useTaskStore.getState().currentTaskId).toBe('old')
  })
})

it('does not resurrect a history note deleted after it was recognized as already imported', async () => {
  getResult.mockResolvedValue(successfulResult)
  await useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  await useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
  useTaskStore.setState({ tasks: [] })
  await useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
  expect(useTaskStore.getState().tasks).toHaveLength(0)
  expect(getResult).toHaveBeenCalledTimes(1)
})
