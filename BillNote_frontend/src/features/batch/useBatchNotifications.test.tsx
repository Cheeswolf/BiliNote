import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import toast, { useToasterStore } from 'react-hot-toast'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTaskPolling } from '@/hooks/useTaskPolling'
import { get_task_status } from '@/services/note'
import { useTaskStore } from '@/store/taskStore'
import { getBatch } from './api'
import { useBatchStore } from './store'
import { detailWithJob, successfulResult } from './testFixtures'
import type { BatchDetail } from './types'
import { useBatchPolling } from './useBatchPolling'

vi.mock('./api', () => ({ getBatch: vi.fn() }))
vi.mock('@/services/note', () => ({
  get_task_status: vi.fn(), generateNote: vi.fn(), delete_task: vi.fn(),
}))
const tick = async (ms = 0) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}
const observe = (id = 'batch-1') => renderHook(() => {
  useBatchPolling(id, 10)
  useTaskPolling(10)
  return useToasterStore().toasts
}, { wrapper: StrictMode })
const terminal = (status: 'COMPLETED' | 'PARTIAL' = 'COMPLETED'): BatchDetail => ({
  ...detailWithJob(status === 'COMPLETED' ? 'SUCCESS' : 'FAILED'), status,
})
beforeEach(async () => {
  vi.useFakeTimers()
  toast.remove()
  localStorage.clear()
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], currentTaskId: null })
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  useBatchStore.getState().notifyTerminalOutcome(detailWithJob())
  vi.mocked(getBatch).mockReset().mockResolvedValue(terminal())
  vi.mocked(get_task_status).mockReset().mockResolvedValue(successfulResult)
})
afterEach(() => { toast.remove(); vi.useRealTimers() })

it('emits one Chinese batch summary after the last video, with no per-video success popups', async () => {
  const running = detailWithJob('SUCCESS')
  running.total = 2
  running.counts.SUMMARIZING = 1
  running.jobs.push({ ...running.jobs[0], task_id: 'task-2', position: 1, status: 'SUMMARIZING' })
  const done: BatchDetail = {
    ...running, status: 'PARTIAL', updated_at: '2026-09-10T10:01:00',
    counts: { ...running.counts, SUMMARIZING: 0, FAILED: 1 },
    jobs: [running.jobs[0], { ...running.jobs[1], status: 'FAILED', error_message: 'Unavailable' }],
  }
  vi.mocked(getBatch).mockResolvedValue(running)
  const { result } = observe()
  await tick()
  expect(useTaskStore.getState().tasks).toHaveLength(1)
  expect(result.current).toHaveLength(0)
  vi.mocked(getBatch).mockResolvedValue(done)
  await tick(10)
  expect(result.current).toHaveLength(1)
  expect(result.current[0].message).toContain('部分异常')
  expect(result.current[0].message).toContain('Lecture notes')
  expect(result.current[0].message).toContain('成功 1 / 2')
  expect(result.current[0].message).toContain('失败 1')
  await tick(100)
  expect(result.current).toHaveLength(1)
})

it('dedupes terminal import retries, StrictMode, remount and unchanged cache revalidation', async () => {
  vi.mocked(get_task_status).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(successfulResult)
  const first = observe()
  await tick(100)
  expect(first.result.current).toHaveLength(1)
  expect(first.result.current[0].message).toContain('已完成')
  expect(useTaskStore.getState().tasks).toHaveLength(1)
  first.unmount()
  const reopened = observe()
  await tick()
  expect(reopened.result.current).toHaveLength(1)
  await act(async () => useBatchStore.getState().invalidateDetail('batch-1'))
  await tick(100)
  expect(reopened.result.current).toHaveLength(1)
})

it('notifies a new terminal attempt even when retry finishes between polls with the same counts', async () => {
  vi.mocked(getBatch).mockResolvedValue(terminal('PARTIAL'))
  const { result } = observe()
  await tick()
  expect(result.current).toHaveLength(1)
  const retried = terminal('PARTIAL')
  retried.jobs[0].attempt = 2
  // Attempts disambiguate even if the timestamp precision yields the same value.
  vi.mocked(getBatch).mockResolvedValue(retried)
  await act(async () => useBatchStore.getState().invalidateDetail('batch-1'))
  await tick()
  expect(result.current).toHaveLength(2)
  await act(async () => useBatchStore.getState().invalidateDetail('batch-1'))
  await tick()
  expect(result.current).toHaveLength(2)
})

it('notifies again after a resumed batch reaches a new terminal server revision', async () => {
  vi.mocked(getBatch).mockResolvedValue(terminal('PARTIAL'))
  const { result } = observe()
  await tick()
  expect(result.current).toHaveLength(1)
  vi.mocked(getBatch).mockResolvedValueOnce(detailWithJob('SUMMARIZING'))
    .mockResolvedValue({ ...terminal(), updated_at: '2026-09-10T10:02:00' })
  await act(async () => useBatchStore.getState().invalidateDetail('batch-1'))
  await tick()
  expect(result.current).toHaveLength(1)
  await tick(10)
  expect(result.current).toHaveLength(2)
  expect(result.current[0].message).toContain('已完成')
})

it('tracks terminal outcomes independently across batches', async () => {
  const first = observe()
  await tick()
  first.unmount()
  vi.mocked(getBatch).mockResolvedValue({ ...terminal(), id: 'batch-2', name: '第二批' })
  useBatchStore.getState().notifyTerminalOutcome(detailWithJob('SUMMARIZING', 'batch-2'))
  const second = observe('batch-2')
  await tick()
  expect(second.result.current).toHaveLength(2)
  expect(second.result.current[0].message).toContain('第二批')
  second.unmount()
  vi.mocked(getBatch).mockResolvedValue(terminal())
  const reopened = observe()
  await tick()
  expect(reopened.result.current).toHaveLength(2)
})

it.each(['PAUSED', 'RECOVERABLE', 'CANCELLED'] as const)('does not emit completion for %s', async status => {
  vi.mocked(getBatch).mockResolvedValue({ ...detailWithJob('CANCELLED'), status })
  const { result } = observe()
  await tick(30)
  expect(result.current).toHaveLength(0)
})

it('never notifies from a stale terminal read invalidated by a management action', async () => {
  let resolve!: (detail: BatchDetail) => void
  vi.mocked(getBatch).mockReturnValueOnce(new Promise(r => { resolve = r }))
    .mockResolvedValue(detailWithJob('SUMMARIZING'))
  const { result } = observe()
  await tick()
  await act(async () => {
    useBatchStore.getState().invalidateDetail('batch-1')
    resolve(terminal('PARTIAL'))
  })
  await tick(20)
  expect(result.current).toHaveLength(0)
  expect(useBatchStore.getState().active?.status).toBe('RUNNING')
})

it('ignores timestamp-only and job-order changes after a no-op management refresh', async () => {
  const done = terminal('PARTIAL')
  done.jobs.push({ ...done.jobs[0], task_id: 'task-2', position: 1 })
  vi.mocked(getBatch).mockResolvedValue(done)
  const { result } = observe()
  await tick()
  expect(result.current).toHaveLength(1)
  vi.mocked(getBatch).mockResolvedValue({
    ...done, updated_at: '2026-09-15T12:00:00',
    jobs: [...done.jobs].reverse().map(job => ({ ...job, updated_at: 'later', position: 9 })),
  })
  await act(async () => useBatchStore.getState().invalidateDetail('batch-1'))
  await tick()
  expect(result.current).toHaveLength(1)
})

it('retains an outcome receipt after a complete store module reload', async () => {
  const done = terminal('PARTIAL')
  useBatchStore.getState().notifyTerminalOutcome(done)
  const before = JSON.stringify(localStorage)
  vi.resetModules()
  const { useBatchStore: restarted } = await import('./store')
  const messages = renderHook(() => useToasterStore().toasts)
  await act(async () => restarted.getState().notifyTerminalOutcome(done))
  expect(messages.result.current).toHaveLength(1)
  expect(before).not.toBe('{}')
})


it('silently baselines first-discovered historical terminal batches', async () => {
  localStorage.clear()
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  const { result } = observe()
  await tick(30)
  expect(result.current).toHaveLength(0)
  expect(useTaskStore.getState().tasks).toHaveLength(1)
})

it('does not lose progress or imports when notification storage throws', async () => {
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  try {
    const { result } = observe()
    await tick(30)
    expect(result.current).toHaveLength(1)
    expect(useBatchStore.getState().active?.status).toBe('COMPLETED')
    expect(useTaskStore.getState().tasks).toHaveLength(1)
    expect(useBatchStore.getState().error).toBeNull()
  } finally { read.mockRestore(); write.mockRestore() }
})

it('keeps a persisted nonterminal observation eligible after a store restart', async () => {
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  const { result } = observe()
  await tick()
  expect(result.current).toHaveLength(1)
})

it('recovers malformed storage and prunes old batches and old outcomes', async () => {
  const key = 'bilinote-batch-outcomes'
  localStorage.setItem(key, '{broken')
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  const { result } = observe()
  await tick()
  expect(result.current).toHaveLength(0)
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ version: 1 })
  const done = terminal('PARTIAL')
  await act(async () => {
    for (let index = 0; index < 210; index++)
      useBatchStore.getState().notifyTerminalOutcome({ ...done, id: 'old-' + index })
    for (let attempt = 1; attempt <= 12; attempt++)
      useBatchStore.getState().notifyTerminalOutcome({ ...done, jobs: [{ ...done.jobs[0], attempt }] })
  })
  const saved = JSON.parse(localStorage.getItem(key)!)
  expect(saved.receipts.length).toBeLessThanOrEqual(200)
  expect(saved.receipts.some((entry: { batchId: string }) => entry.batchId === 'old-0')).toBe(false)
  expect(saved.receipts.find((entry: { batchId: string }) => entry.batchId === 'batch-1').outcomes.length).toBeLessThanOrEqual(8)
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  toast.remove()
  await act(async () => useBatchStore.getState().notifyTerminalOutcome({ ...done, jobs: [{ ...done.jobs[0], attempt: 12 }] }))
  expect(result.current).toHaveLength(0)
})


it('retains observed running batches while pruning a large historical backlog', async () => {
  const { result } = renderHook(() => useToasterStore().toasts)
  await act(async () => {
    for (let index = 0; index < 210; index++)
      useBatchStore.getState().notifyTerminalOutcome({ ...terminal('PARTIAL'), id: 'history-' + index })
  })
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  await act(async () => useBatchStore.getState().notifyTerminalOutcome(terminal()))
  expect(result.current).toHaveLength(1)
})

it.each([
  { version: 99, receipts: [] },
  { version: 1, receipts: [null, { batchId: 'bad', outcomes: 4 }, { batchId: 'batch-1', outcomes: [null], touchedAt: 0 }] },
  { version: 1, receipts: [{ batchId: 'batch-1', outcomes: [], touchedAt: Date.now() - 31 * 86400000 }] },
])('recovers invalid or expired receipt records without historical notifications: %j', async saved => {
  localStorage.setItem('bilinote-batch-outcomes', JSON.stringify(saved))
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  const { result } = observe()
  await tick()
  expect(result.current).toHaveLength(0)
  const repaired = JSON.parse(localStorage.getItem('bilinote-batch-outcomes')!)
  expect(repaired.version).toBe(1)
  expect(repaired.receipts).toHaveLength(1)
})


it('keeps a no-op management race silent after an already announced outcome', async () => {
  const { result } = observe()
  await tick()
  expect(result.current).toHaveLength(1)
  let resolve!: (detail: BatchDetail) => void
  vi.mocked(getBatch).mockReturnValueOnce(new Promise(r => { resolve = r }))
    .mockResolvedValue({ ...terminal(), updated_at: '2026-09-16T12:00:00' })
  await act(async () => useBatchStore.getState().invalidateDetail('batch-1'))
  await tick()
  await act(async () => {
    useBatchStore.getState().invalidateDetail('batch-1')
    resolve({ ...terminal(), updated_at: '2026-09-16T11:59:59' })
  })
  await tick(20)
  expect(result.current).toHaveLength(1)
  expect(useBatchStore.getState().active?.updated_at).toBe('2026-09-16T12:00:00')
})
