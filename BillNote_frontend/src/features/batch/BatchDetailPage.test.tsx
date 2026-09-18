import { beforeEach, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { get_task_status } from '@/services/note'
import { useTaskStore } from '@/store/taskStore'
import { cancelPending, getBatch, pauseBatch, resumeBatch, retryFailed } from './api'
import { useBatchStore } from './store'
import { detailWithJob, successfulResult } from './testFixtures'
import BatchDetailPage from './BatchDetailPage'
vi.mock('./api', () => ({
  getBatch: vi.fn(), pauseBatch: vi.fn(), resumeBatch: vi.fn(), retryFailed: vi.fn(), cancelPending: vi.fn(),
}))
vi.mock('@/services/note', () => ({ get_task_status: vi.fn(), generateNote: vi.fn(), delete_task: vi.fn() }))
const mount = () => render(
  <MemoryRouter initialEntries={['/batch/batch-1']}><Routes>
    <Route path="/batch/:batchId" element={<BatchDetailPage />} />
    <Route path="/" element={<p>原有笔记预览</p>} />
  </Routes></MemoryRouter>
)
beforeEach(async () => {
  vi.clearAllMocks()
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], currentTaskId: null, batchImportedAttempts: {} })
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  vi.mocked(getBatch).mockResolvedValue(detailWithJob())
  vi.mocked(get_task_status).mockResolvedValue(successfulResult)
})
it('renders ordered real stages, failed reasons, and counts without invented timing', async () => {
  const detail = detailWithJob()
  detail.jobs = [
    { ...detail.jobs[0], task_id: 'third', position: 2, title: '第三条', status: 'FAILED', error_message: '下载被拒绝' },
    { ...detail.jobs[0], task_id: 'first', position: 0, title: '第一条', status: 'FORMATTING' },
    { ...detail.jobs[0], task_id: 'second', position: 1, title: '第二条', status: 'PENDING' },
  ]
  detail.total = 3
  detail.counts = { ...detail.counts, SUMMARIZING: 0, FORMATTING: 1, PENDING: 1, FAILED: 1 }
  vi.mocked(getBatch).mockResolvedValue(detail)
  mount()
  await screen.findByText('下载被拒绝')
  expect(screen.getAllByRole('article').map(row => row.textContent)).toEqual([
    expect.stringContaining('第一条'), expect.stringContaining('第二条'), expect.stringContaining('第三条'),
  ])
  expect(screen.getByText('排版中')).toBeTruthy()
  expect(screen.getByText('失败 1')).toBeTruthy()
  expect(screen.getByText('等待 1')).toBeTruthy()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1')
})
it('requires manual continue for a recoverable batch and refreshes after the mutation', async () => {
  const recovered = { ...detailWithJob('INTERRUPTED'), status: 'RECOVERABLE' as const }
  vi.mocked(getBatch).mockResolvedValue(recovered)
  vi.mocked(resumeBatch).mockImplementation(async () => {
    const next = detailWithJob('DOWNLOADING')
    vi.mocked(getBatch).mockResolvedValue(next)
    return next
  })
  mount()
  await screen.findByText('已中断')
  expect(resumeBatch).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '继续生成' }))
  await screen.findByText('下载中')
  expect(resumeBatch).toHaveBeenCalledWith('batch-1')
  expect(getBatch).toHaveBeenCalledTimes(2)
})
it('retries only through the failed-items API and refreshes the terminal batch', async () => {
  const failed = { ...detailWithJob('FAILED'), status: 'PARTIAL' as const }
  vi.mocked(getBatch).mockResolvedValue(failed)
  vi.mocked(retryFailed).mockImplementation(async () => {
    const next = detailWithJob('PENDING')
    vi.mocked(getBatch).mockResolvedValue(next)
    return next
  })
  mount()
  await screen.findByText('失败')
  await userEvent.click(screen.getByRole('button', { name: '重试失败项' }))
  await screen.findByText('等待中')
  expect(retryFailed).toHaveBeenCalledWith('batch-1')
  expect(resumeBatch).not.toHaveBeenCalled()
})
it('pauses after the current item and cancels only pending jobs', async () => {
  const detail = detailWithJob('PENDING')
  vi.mocked(getBatch).mockResolvedValue(detail)
  vi.mocked(pauseBatch).mockImplementation(async () => {
    const paused = { ...detail, status: 'PAUSED' as const }
    vi.mocked(getBatch).mockResolvedValue(paused)
    return paused
  })
  vi.mocked(cancelPending).mockImplementation(async () => {
    const cancelled = { ...detailWithJob('CANCELLED'), status: 'CANCELLED' as const }
    vi.mocked(getBatch).mockResolvedValue(cancelled)
    return cancelled
  })
  mount()
  await screen.findByText('等待中')
  await userEvent.click(screen.getByRole('button', { name: '停止后续任务' }))
  await screen.findByText('已暂停')
  await userEvent.click(screen.getByRole('button', { name: '取消等待项' }))
  await waitFor(() => expect(screen.queryByText('等待中')).toBeNull())
  expect(pauseBatch).toHaveBeenCalledWith('batch-1')
  expect(cancelPending).toHaveBeenCalledWith('batch-1')
})
it('opens a successful imported note through the real task-store selection and home route', async () => {
  vi.mocked(getBatch).mockResolvedValue({ ...detailWithJob('SUCCESS'), status: 'COMPLETED' })
  mount()
  const open = await screen.findByRole('button', { name: '打开笔记' })
  await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false))
  expect(useTaskStore.getState().currentTaskId).toBeNull()
  await userEvent.click(open)
  await screen.findByText('原有笔记预览')
  expect(useTaskStore.getState().getCurrentTask()).toMatchObject({
    id: 'task-1', status: 'SUCCESS', markdown: [expect.objectContaining({ content: '# Imported lecture' })],
  })
})
it('keeps server stages visible while connection is lost', async () => {
  mount()
  await screen.findByText('生成中')
  act(() => useBatchStore.setState({ connection: 'offline', error: 'network down' }))
  expect(screen.getByText(/连接中断/)).toBeTruthy()
  expect(screen.getByText('生成中')).toBeTruthy()
  expect(screen.queryByText('失败')).toBeNull()
})

it('shows a deleted imported note after restart and restores it only on explicit action', async () => {
  const detail = { ...detailWithJob('SUCCESS'), status: 'COMPLETED' as const }
  await useBatchStore.getState().importSuccessfulTasks(detail)
  await useTaskStore.getState().removeTask('task-1')
  await useTaskStore.persist.rehydrate()
  vi.mocked(get_task_status).mockClear()
  vi.mocked(getBatch).mockResolvedValue(detail)
  mount()
  await screen.findByText(/已从笔记历史删除/)
  expect(screen.queryByText('正在载入笔记，将自动重试')).toBeNull()
  expect(get_task_status).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: '恢复并打开笔记' }))
  await screen.findByText('原有笔记预览')
  expect(get_task_status).toHaveBeenCalledTimes(1)
  expect(useTaskStore.getState().getCurrentTask()?.id).toBe('task-1')
})

it('keeps restoration actionable if the restored note cannot be persisted', async () => {
  const detail = { ...detailWithJob('SUCCESS'), status: 'COMPLETED' as const }
  await useBatchStore.getState().importSuccessfulTasks(detail)
  await useTaskStore.getState().removeTask('task-1')
  vi.mocked(getBatch).mockResolvedValue(detail)
  mount()
  await screen.findByText(/已从笔记历史删除/)
  const write = vi.spyOn(useTaskStore.persist.getOptions().storage!, 'setItem').mockRejectedValueOnce(new Error('disk full'))
  await userEvent.click(screen.getByRole('button', { name: '恢复并打开笔记' }))
  expect((await screen.findByRole('alert')).textContent).toContain('disk full')
  write.mockRestore()
  expect(screen.getByRole('button', { name: '恢复并打开笔记' })).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: '恢复并打开笔记' }))
  await screen.findByText('原有笔记预览')
  expect(useTaskStore.getState().getCurrentTask()?.id).toBe('task-1')
})
it('shows a management error without changing the server status and permits retry', async () => {
  vi.mocked(pauseBatch).mockRejectedValue(new Error('cannot pause'))
  mount()
  await screen.findByText('生成中')
  await userEvent.click(screen.getByRole('button', { name: '停止后续任务' }))
  expect((await screen.findByRole('alert')).textContent).toContain('cannot pause')
  expect(screen.getByText('生成中')).toBeTruthy()
  expect((screen.getByRole('button', { name: '停止后续任务' }) as HTMLButtonElement).disabled).toBe(false)
})

it('displays the actual FastAPI error when a batch cannot be loaded', async () => {
  vi.mocked(getBatch).mockRejectedValue({ detail: 'Batch not found' })
  mount()
  expect((await screen.findByRole('alert')).textContent).toContain('Batch not found')
  expect(screen.queryByText('生成中')).toBeNull()
})

it('revalidates after retry, a delayed refresh, and leaving then reopening the detail without overlapping reads', async () => {
  const failed = { ...detailWithJob('FAILED'), status: 'PARTIAL' as const }
  const next = detailWithJob('DOWNLOADING')
  let finishRefresh!: (value: typeof next) => void
  vi.mocked(getBatch).mockResolvedValueOnce(failed)
    .mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve }))
    .mockResolvedValue(next)
  vi.mocked(retryFailed).mockResolvedValue(detailWithJob('PENDING'))
  render(<MemoryRouter initialEntries={['/batch/batch-1']}><Routes>
    <Route path="/batch/:batchId" element={<BatchDetailPage />} />
    <Route path="/batch" element={<Link to="/batch/batch-1">重新打开批次</Link>} />
  </Routes></MemoryRouter>)
  await screen.findByText('失败')
  await userEvent.click(screen.getByRole('button', { name: '重试失败项' }))
  await waitFor(() => expect(getBatch).toHaveBeenCalledTimes(2))
  const cachedAfterMutation = useBatchStore.getState().active
  await userEvent.click(screen.getByRole('link', { name: '批量任务中心' }))
  await userEvent.click(screen.getByRole('link', { name: '重新打开批次' }))
  const readsWhilePreviousIsPending = vi.mocked(getBatch).mock.calls.length
  await act(async () => finishRefresh(next))
  expect(cachedAfterMutation?.status).not.toBe('PARTIAL')
  expect(readsWhilePreviousIsPending).toBe(2)
  await screen.findByText('下载中')
  expect(getBatch).toHaveBeenCalledTimes(3)
})

it('revalidates the reopened detail when a mutation started by its old instance finally succeeds', async () => {
  const failed = { ...detailWithJob('FAILED'), status: 'PARTIAL' as const }
  const next = detailWithJob('DOWNLOADING')
  let finishMutation!: (value: typeof next) => void
  vi.mocked(getBatch).mockResolvedValue(failed)
  vi.mocked(retryFailed).mockImplementationOnce(() => new Promise(resolve => { finishMutation = resolve }))
  render(<MemoryRouter initialEntries={['/batch/batch-1']}><Routes>
    <Route path="/batch/:batchId" element={<BatchDetailPage />} />
    <Route path="/batch" element={<Link to="/batch/batch-1">重新打开批次</Link>} />
  </Routes></MemoryRouter>)
  await screen.findByText('失败')
  await userEvent.click(screen.getByRole('button', { name: '重试失败项' }))
  expect(retryFailed).toHaveBeenCalledWith('batch-1')
  await userEvent.click(screen.getByRole('link', { name: '批量任务中心' }))
  await userEvent.click(screen.getByRole('link', { name: '重新打开批次' }))
  await waitFor(() => expect(getBatch).toHaveBeenCalledTimes(2))
  await screen.findByText('失败')
  expect(useBatchStore.getState().active?.status).toBe('PARTIAL')
  vi.mocked(getBatch).mockResolvedValue(next)
  await act(async () => finishMutation(detailWithJob('PENDING')))
  await screen.findByText('下载中')
  expect(getBatch).toHaveBeenCalledTimes(3)
  expect(useBatchStore.getState().active?.status).toBe('RUNNING')
})

it('does not invalidate another batch when a mutation from the previous detail succeeds', async () => {
  const failed = { ...detailWithJob('FAILED'), status: 'PARTIAL' as const }
  const other = { ...detailWithJob('CANCELLED', 'batch-2'), status: 'CANCELLED' as const, name: '另一个批次' }
  let finishMutation!: (value: typeof failed) => void
  vi.mocked(getBatch).mockImplementation(async id => id === 'batch-1' ? failed : other)
  vi.mocked(retryFailed).mockImplementationOnce(() => new Promise(resolve => { finishMutation = resolve }))
  render(<MemoryRouter initialEntries={['/batch/batch-1']}><Routes>
    <Route path="/batch/:batchId" element={<BatchDetailPage />} />
    <Route path="/batch" element={<Link to="/batch/batch-2">打开另一个批次</Link>} />
  </Routes></MemoryRouter>)
  await screen.findByText('失败')
  await userEvent.click(screen.getByRole('button', { name: '重试失败项' }))
  await userEvent.click(screen.getByRole('link', { name: '批量任务中心' }))
  await userEvent.click(screen.getByRole('link', { name: '打开另一个批次' }))
  await screen.findByRole('heading', { name: '另一个批次' })
  await act(async () => finishMutation(failed))
  expect(screen.getByRole('heading', { name: '另一个批次' })).toBeTruthy()
  expect(useBatchStore.getState().active).toEqual(other)
  expect(getBatch).toHaveBeenCalledTimes(2)
})
