import * as idb from 'idb-keyval'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTaskStore } from '@/store/taskStore'
import { get_task_status } from '@/services/note'
import { useTaskPolling } from './useTaskPolling'
vi.mock('@/services/note', () => ({
  get_task_status: vi.fn(),
  generateNote: vi.fn(),
  delete_task: vi.fn(),
}))
beforeEach(async () => {
  vi.useFakeTimers()
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], connections: {} })
  useTaskStore.getState().addPendingTask('one', 'youtube')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('records connectivity on network failure without changing the task status', async () => {
  vi.mocked(get_task_status).mockRejectedValueOnce(new Error('offline'))
  renderHook(() => useTaskPolling(10))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  expect(useTaskStore.getState().tasks[0].status).toBe('PENDING')
  expect(useTaskStore.getState().connections.one).toBe('offline')
  expect(get_task_status).toHaveBeenCalledWith('one', { suppressToast: true })
})
it.each(['FAILED', 'INTERRUPTED', 'CANCELLED', 'SUCCESS'] as const)(
  'does not poll %s tasks',
  async status => {
    useTaskStore.getState().updateTaskContent('one', { status })
    renderHook(() => useTaskPolling(10))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(get_task_status).not.toHaveBeenCalled()
  }
)

it('marks the explicit legacy task failure envelope FAILED and stops polling', async () => {
  vi.mocked(get_task_status).mockRejectedValueOnce({
    code: 500,
    msg: 'legacy task failed',
    data: null,
  })
  renderHook(() => useTaskPolling(10))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(useTaskStore.getState().tasks[0].status).toBe('FAILED')
  expect(useTaskStore.getState().connections.one).toBe('online')
  expect(get_task_status).toHaveBeenCalledTimes(1)
})
it('preserves the backend stage on the normalized code -1 network envelope', async () => {
  useTaskStore.getState().updateTaskContent('one', { status: 'SUMMARIZING' })
  vi.mocked(get_task_status).mockRejectedValueOnce({
    code: -1,
    msg: 'Network unavailable',
    data: null,
  })
  renderHook(() => useTaskPolling(10))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  expect(useTaskStore.getState().tasks[0].status).toBe('SUMMARIZING')
  expect(useTaskStore.getState().connections.one).toBe('offline')
})
it('does not write task history or replace task objects for unchanged polling status', async () => {
  const write = vi.spyOn(idb, 'set')
  const tasks = useTaskStore.getState().tasks
  vi.mocked(get_task_status).mockResolvedValue({ status: 'PENDING', task_id: 'one', message: '' })
  renderHook(() => useTaskPolling(10))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30)
  })
  expect(useTaskStore.getState().tasks).toBe(tasks)
  expect(write).not.toHaveBeenCalled()
  write.mockRestore()
})
it('updates transient connectivity without history writes and skips duplicate notifications', () => {
  const write = vi.spyOn(idb, 'set')
  const listener = vi.fn()
  const unsubscribe = useTaskStore.subscribe(listener)
  const tasks = useTaskStore.getState().tasks
  try {
    useTaskStore.getState().setTaskConnection('one', 'offline')
    useTaskStore.getState().setTaskConnection('one', 'offline')
    useTaskStore.getState().setTaskConnection('one', 'online')
    useTaskStore.getState().setTaskConnection('one', 'online')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(useTaskStore.getState().tasks).toBe(tasks)
    expect(write).not.toHaveBeenCalled()
  } finally {
    unsubscribe()
    write.mockRestore()
  }
})
