import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import toast, { useToasterStore } from 'react-hot-toast'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { get_task_status } from '@/services/note'
import { useTaskStore } from '@/store/taskStore'
import { getBatch, listBatches } from './api'
import { useBatchStore } from './store'
import { detailWithJob, successfulResult } from './testFixtures'
import { useBatchObserver } from './useBatchObserver'
import { useBatchPolling } from './useBatchPolling'
import type { BatchDetail } from './types'
vi.mock('./api', () => ({ getBatch: vi.fn(), listBatches: vi.fn() }))
vi.mock('@/services/note', () => ({ get_task_status: vi.fn(), generateNote: vi.fn(), delete_task: vi.fn() }))
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
const done = (id = 'batch-1'): BatchDetail => ({ ...detailWithJob('FAILED', id), status: 'PARTIAL' })
const list = (items: BatchDetail[]) => ({ items, total: items.length, page: 1, page_size: 100 })
beforeEach(async () => {
  vi.useFakeTimers()
  localStorage.clear()
  toast.remove()
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], currentTaskId: null })
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  vi.mocked(getBatch).mockReset().mockResolvedValue(detailWithJob())
  vi.mocked(listBatches).mockReset().mockResolvedValue(list([detailWithJob()]))
  vi.mocked(get_task_status).mockReset().mockResolvedValue(successfulResult)
})
afterEach(() => { vi.useRealTimers(); toast.remove() })
const observe = () => renderHook(() => { useBatchObserver(true, 10); return useToasterStore().toasts }, { wrapper: StrictMode })

it('uses one detail polling owner, takes over on unmount, and stops after observer cleanup', async () => {
  const detail = renderHook(() => useBatchPolling('batch-1', 10), { wrapper: StrictMode })
  const global = observe()
  await tick()
  const initialReads = vi.mocked(getBatch).mock.calls.length
  await tick(20)
  expect(getBatch).toHaveBeenCalledTimes(initialReads + 2)
  detail.unmount()
  vi.mocked(listBatches).mockResolvedValue(list([done()]))
  vi.mocked(getBatch).mockResolvedValue(done())
  await tick(10)
  expect(global.result.current).toHaveLength(1)
  expect(getBatch).toHaveBeenCalledTimes(initialReads + 3)
  await tick(50)
  expect(getBatch).toHaveBeenCalledTimes(initialReads + 3)
  global.unmount()
  const scans = vi.mocked(listBatches).mock.calls.length
  await tick(50)
  expect(listBatches).toHaveBeenCalledTimes(scans)
})

it('serializes a slow global read with detail mounting and suppresses the invalidated result', async () => {
  let resolve!: (detail: BatchDetail) => void
  vi.mocked(getBatch).mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValue(detailWithJob())
  const global = observe()
  await tick()
  renderHook(() => useBatchPolling('batch-1', 10))
  await tick(50)
  expect(getBatch).toHaveBeenCalledTimes(1)
  await act(async () => { useBatchStore.getState().invalidateDetail('batch-1'); resolve(done()) })
  await tick()
  expect(global.result.current).toHaveLength(0)
  expect(useBatchStore.getState().active?.status).toBe('RUNNING')
  await tick(10)
  expect(getBatch).toHaveBeenCalledTimes(3)
})

it('discovers later pages and notifies each observed batch independently without replaying history', async () => {
  const history = done('history')
  let terminal = false
  vi.mocked(listBatches).mockImplementation(async (page = 1) => ({
    items: page === 1 ? [history] : [terminal ? done() : detailWithJob()], total: 2, page, page_size: 1,
  }))
  vi.mocked(getBatch).mockImplementation(async id => id === 'history' ? history : terminal ? done() : detailWithJob())
  const global = observe()
  await tick()
  expect(global.result.current).toHaveLength(0)
  terminal = true
  await tick(10)
  expect(global.result.current).toHaveLength(1)
  expect(listBatches).toHaveBeenCalledWith(2, 100, { suppressToast: true })
  await tick(20)
  expect(global.result.current).toHaveLength(1)
})

it('does not import historical terminal notes merely by opening the app', async () => {
  const history: BatchDetail = { ...detailWithJob('SUCCESS'), status: 'COMPLETED' }
  vi.mocked(listBatches).mockResolvedValue(list([history]))
  vi.mocked(getBatch).mockResolvedValue(history)
  const global = observe()
  await tick()
  expect(global.result.current).toHaveLength(0)
  expect(useTaskStore.getState().tasks).toHaveLength(0)
})

it('continues other batches after a failed import and retries without per-video popups', async () => {
  useBatchStore.getState().notifyTerminalOutcome(detailWithJob())
  useBatchStore.getState().notifyTerminalOutcome(detailWithJob('SUMMARIZING', 'batch-2'))
  const success: BatchDetail = { ...detailWithJob('SUCCESS'), status: 'COMPLETED' }
  vi.mocked(listBatches).mockResolvedValue(list([success, done('batch-2')]))
  vi.mocked(getBatch).mockImplementation(async id => id === 'batch-1' ? success : done('batch-2'))
  vi.mocked(get_task_status).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(successfulResult)
  const global = observe()
  await tick()
  expect(global.result.current).toHaveLength(2)
  expect(useTaskStore.getState().tasks).toHaveLength(0)
  await tick(20)
  expect(global.result.current).toHaveLength(2)
  expect(useTaskStore.getState().tasks).toHaveLength(1)
})


it('waits for backend initialization and cancels the observer when disabled', async () => {
  const observer = renderHook(({ enabled }) => useBatchObserver(enabled, 10), { initialProps: { enabled: false } })
  await tick(50)
  expect(listBatches).not.toHaveBeenCalled()
  observer.rerender({ enabled: true })
  await tick()
  expect(listBatches).toHaveBeenCalledTimes(1)
  observer.rerender({ enabled: false })
  await tick(50)
  expect(listBatches).toHaveBeenCalledTimes(1)
})
