import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useBatchPolling } from './useBatchPolling'
import { getBatch } from './api'
import { useBatchStore } from './store'
import { useTaskStore } from '@/store/taskStore'
import { get_task_status } from '@/services/note'
import { detailWithJob, successfulResult } from './testFixtures'
import type { BatchDetail } from './types'
vi.mock('./api', () => ({ getBatch: vi.fn() }))
vi.mock('@/services/note', () => ({
  get_task_status: vi.fn(),
  generateNote: vi.fn(),
  delete_task: vi.fn(),
}))
const getBatchMock = vi.mocked(getBatch)
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
beforeEach(async () => {
  vi.useFakeTimers()
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], currentTaskId: null })
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  getBatchMock.mockReset().mockResolvedValue(detailWithJob())
  vi.mocked(get_task_status).mockResolvedValue(successfulResult)
})
afterEach(() => vi.useRealTimers())
it('keeps job status when polling loses the backend', async () => {
  useBatchStore.setState({ active: detailWithJob(), connection: 'online' })
  getBatchMock.mockRejectedValueOnce(new Error('offline'))
  renderHook(() => useBatchPolling('batch-1', 10))
  await tick()
  expect(useBatchStore.getState().connection).toBe('offline')
  expect(useBatchStore.getState().active?.jobs[0].status).toBe('SUMMARIZING')
})
it('never overlaps a slow request and cancels timers on unmount', async () => {
  let resolve!: (detail: BatchDetail) => void
  getBatchMock.mockReturnValueOnce(
    new Promise(r => {
      resolve = r
    })
  )
  const { unmount } = renderHook(() => useBatchPolling('batch-1', 10))
  await tick(100)
  expect(getBatchMock).toHaveBeenCalledTimes(1)
  await act(async () => resolve(detailWithJob()))
  await tick(10)
  expect(getBatchMock).toHaveBeenCalledTimes(2)
  unmount()
  await tick(100)
  expect(getBatchMock).toHaveBeenCalledTimes(2)
})
it('backs off on errors, shows reconnecting, and resets delay after success', async () => {
  let resolve!: (detail: BatchDetail) => void
  getBatchMock.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(
    new Promise(r => {
      resolve = r
    })
  )
  renderHook(() => useBatchPolling('batch-1', 10))
  await tick()
  await tick(19)
  expect(getBatchMock).toHaveBeenCalledTimes(1)
  await tick(1)
  expect(useBatchStore.getState().connection).toBe('reconnecting')
  await act(async () => resolve(detailWithJob()))
  expect(useBatchStore.getState().connection).toBe('online')
  await tick(9)
  expect(getBatchMock).toHaveBeenCalledTimes(2)
  await tick(1)
  expect(getBatchMock).toHaveBeenCalledTimes(3)
})
it.each(['COMPLETED', 'PARTIAL', 'CANCELLED'] as const)(
  'stops polling %s batches',
  async status => {
    getBatchMock.mockResolvedValue({
      ...detailWithJob(status === 'COMPLETED' ? 'SUCCESS' : 'CANCELLED'),
      status,
    })
    renderHook(() => useBatchPolling('batch-1', 10))
    await tick(100)
    expect(getBatchMock).toHaveBeenCalledTimes(1)
  }
)
it('retries terminal result imports without polling the terminal batch again', async () => {
  getBatchMock.mockResolvedValue({ ...detailWithJob('SUCCESS'), status: 'COMPLETED' })
  vi.mocked(get_task_status)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(successfulResult)
  renderHook(() => useBatchPolling('batch-1', 10))
  await tick()
  expect(useTaskStore.getState().tasks).toHaveLength(0)
  await tick(20)
  expect(useTaskStore.getState().tasks).toHaveLength(1)
  expect(getBatchMock).toHaveBeenCalledTimes(1)
})
it('ignores responses from a previous batch after switching selection', async () => {
  let resolve!: (detail: BatchDetail) => void
  getBatchMock
    .mockReturnValueOnce(
      new Promise(r => {
        resolve = r
      })
    )
    .mockResolvedValue(detailWithJob('PARSING', 'batch-2'))
  const { rerender } = renderHook(({ id }) => useBatchPolling(id, 10), {
    initialProps: { id: 'batch-1' },
  })
  rerender({ id: 'batch-2' })
  await act(async () => resolve(detailWithJob()))
  await tick(10)
  expect(useBatchStore.getState().active?.id).toBe('batch-2')
})

it('keeps connectivity online when the server returns an application error', async () => {
  getBatchMock.mockRejectedValueOnce({ code: 500, msg: 'Server error', data: null })
  renderHook(() => useBatchPolling('batch-1', 10))
  await tick()
  expect(useBatchStore.getState().connection).toBe('online')
  expect(useBatchStore.getState().error).toBe('Server error')
})
it('restarts after retry-failed reopens a terminal batch', async () => {
  useBatchStore.setState({ active: { ...detailWithJob('FAILED'), status: 'PARTIAL' } })
  renderHook(() => useBatchPolling('batch-1', 10))
  await tick()
  expect(getBatchMock).not.toHaveBeenCalled()
  await act(async () => useBatchStore.getState().setActive(detailWithJob('PENDING')))
  await tick()
  expect(getBatchMock).toHaveBeenCalledTimes(1)
})

it('serializes StrictMode effect replay and ignores the cleaned-up response', async () => {
  let resolve!: (detail: BatchDetail) => void
  getBatchMock.mockReturnValueOnce(
    new Promise(r => {
      resolve = r
    })
  )
  renderHook(() => useBatchPolling('batch-1', 10), { wrapper: StrictMode })
  await tick(100)
  expect(getBatchMock).toHaveBeenCalledTimes(1)
  await act(async () => resolve(detailWithJob('PARSING')))
  await tick()
  expect(getBatchMock).toHaveBeenCalledTimes(2)
  expect(useBatchStore.getState().active?.jobs[0].status).toBe('SUMMARIZING')
})
it('does not leave duplicate timers when retry reopens a batch during result import', async () => {
  let resolve!: (result: typeof successfulResult) => void
  useBatchStore.setState({ active: { ...detailWithJob('SUCCESS'), status: 'COMPLETED' } })
  vi.mocked(get_task_status).mockReturnValueOnce(
    new Promise(r => {
      resolve = r
    })
  )
  renderHook(() => useBatchPolling('batch-1', 10))
  await tick()
  await act(async () => useBatchStore.getState().setActive(detailWithJob('PENDING')))
  await act(async () => resolve(successfulResult))
  await tick(20)
  expect(getBatchMock).toHaveBeenCalledTimes(2)
})
it('stays online when a terminal result is missing and leaves the task unimported', async () => {
  getBatchMock.mockResolvedValue({ ...detailWithJob('SUCCESS'), status: 'COMPLETED' })
  vi.mocked(get_task_status).mockResolvedValueOnce({
    status: 'SUCCESS',
    task_id: 'task-1',
    message: 'Result missing',
  })
  renderHook(() => useBatchPolling('batch-1', 10))
  await tick()
  expect(useBatchStore.getState().connection).toBe('online')
  expect(useBatchStore.getState().error).toBe('Result missing')
  expect(useTaskStore.getState().tasks).toHaveLength(0)
})
