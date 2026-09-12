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
afterEach(() => vi.useRealTimers())
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
