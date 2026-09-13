import { createJSONStorage } from 'zustand/middleware'
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

it('blocks imports and pending-task writes after a real persist hydration read failure, then preserves old history on recovery', async () => {
  useTaskStore.getState().addPendingTask('existing-note', 'youtube')
  useTaskStore
    .getState()
    .updateTaskContent('existing-note', { status: 'SUCCESS', markdown: 'Existing history' })
  const oldTasks = useTaskStore.getState().tasks
  let persisted = JSON.stringify({
    version: 0,
    state: { tasks: oldTasks, currentTaskId: 'existing-note' },
  })
  const originalHistory = persisted
  useTaskStore.setState({ tasks: [], currentTaskId: null })
  const originalStorage = useTaskStore.persist.getOptions().storage
  let unavailable = true
  const write = vi.fn(async (_name: string, value: string) => {
    persisted = value
  })
  useTaskStore.persist.setOptions({
    storage: createJSONStorage(() => ({
      getItem: async () => {
        if (unavailable) throw new Error('IndexedDB read denied')
        return persisted
      },
      setItem: write,
      removeItem: async () => {},
    })),
  })
  try {
    await useTaskStore.persist.rehydrate()
    expect(useTaskStore.persist.hasHydrated()).toBe(false)
    getResult.mockResolvedValue(successfulResult)
    await expect(
      useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
    ).rejects.toThrow(/history|storage/i)
    expect(() => useTaskStore.getState().addPendingTask('new-pending', 'youtube')).toThrow(
      /history|storage/i
    )
    expect(useTaskStore.getState().tasks).toEqual([])
    expect(useTaskStore.getState().storageError).toMatch(/IndexedDB read denied/)
    expect(write).not.toHaveBeenCalled()
    expect(persisted).toBe(originalHistory)
    expect(getResult).not.toHaveBeenCalled()
    unavailable = false
    await useBatchStore.getState().importSuccessfulTasks(detailWithJob('SUCCESS'))
    expect(useTaskStore.getState().tasks.map(task => task.id)).toEqual(['task-1', 'existing-note'])
    expect(useTaskStore.getState().storageError).toBeNull()
    expect(JSON.parse(persisted).state.tasks).toHaveLength(2)
  } finally {
    useTaskStore.persist.setOptions({ storage: originalStorage })
    await useTaskStore.persist.rehydrate()
  }
})
it('retrieves results with peak concurrency one across concurrent batches, continues failures, and retries only missing imports', async () => {
  const detail = detailWithJob('SUCCESS')
  detail.jobs = ['task-1', 'task-2', 'task-3'].map((task_id, position) => ({
    ...detail.jobs[0],
    task_id,
    position,
  }))
  detail.total = 3
  detail.counts.SUCCESS = 3
  let inFlight = 0
  let peak = 0
  let failSecond = true
  const calls: string[] = []
  getResult.mockImplementation(async id => {
    calls.push(id)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, 1))
    inFlight -= 1
    if (id === 'task-2' && failSecond) throw new Error('offline')
    return { ...successfulResult, task_id: id }
  })
  const other = {
    ...detailWithJob('SUCCESS', 'batch-2'),
    jobs: [{ ...detail.jobs[0], task_id: 'task-4' }],
  }
  const outcomes = await Promise.allSettled([
    useBatchStore.getState().importSuccessfulTasks(detail),
    useBatchStore.getState().importSuccessfulTasks(other),
  ])
  expect(outcomes[0].status).toBe('rejected')
  expect(outcomes[1].status).toBe('fulfilled')
  expect(peak).toBe(1)
  expect(
    useTaskStore
      .getState()
      .tasks.map(task => task.id)
      .sort()
  ).toEqual(['task-1', 'task-3', 'task-4'])
  failSecond = false
  await useBatchStore.getState().importSuccessfulTasks(detail)
  expect(calls).toEqual(['task-1', 'task-2', 'task-3', 'task-4', 'task-2'])
})
