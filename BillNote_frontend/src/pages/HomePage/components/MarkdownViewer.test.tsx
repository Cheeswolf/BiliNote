import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useTaskStore, type Task } from '@/store/taskStore'
import MarkdownViewer from './MarkdownViewer'
import toast from 'react-hot-toast'

// Animation players require browser canvas; keep Markdown rendering and selection real.
vi.mock('lottie-react', () => ({ default: () => null }))
vi.mock('@lottiefiles/dotlottie-react', () => ({ DotLottieReact: () => null }))
// Imported chat/model modules load configuration; isolate HTTP while keeping rendering real.
vi.mock('@/services/model', () => ({ fetchEnableModels: vi.fn().mockResolvedValue([]) }))

const legacy = {
  id: 'viewer-note', status: 'SUCCESS', createdAt: '2025-01-01',
  markdown: [
    { ver_id: 'older', content: '# Server version', style: '', model_name: '', created_at: '2025-01-02' },
    { ver_id: 'newer', content: '# Local edited version', style: '', model_name: '', created_at: '2030-01-01' },
  ],
  formData: { video_url: '', platform: 'youtube', quality: '', model_name: '', provider_id: '' },
  audioMeta: { title: 'Lecture', cover_url: '', duration: 0, file_path: '', platform: 'youtube', video_id: '', raw_info: null },
  transcript: { full_text: '', language: '', raw: null, segments: [] },
} satisfies Task
beforeEach(async () => {
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [legacy], currentTaskId: legacy.id, batchImportedAttempts: {} })
})

it('keeps timestamp-based selection for legacy notes without a current version ID', async () => {
  render(<MarkdownViewer content="" status="success" />)
  expect(await screen.findByRole('heading', { name: 'Local edited version' })).toBeTruthy()
})

it('opens the persisted current version even when another history item has a later timestamp', async () => {
  useTaskStore.setState({ tasks: [{ ...legacy, currentMarkdownVersionId: 'older' }] })
  await useTaskStore.persist.rehydrate()
  render(<MarkdownViewer content="" status="success" />)
  expect(await screen.findByRole('heading', { name: 'Server version' })).toBeTruthy()
})

it('switches a mounted successful note to the imported version and a subsequent local edit', async () => {
  const view = render(<MarkdownViewer content="" status="success" />)
  expect(await screen.findByRole('heading', { name: 'Local edited version' })).toBeTruthy()
  await act(async () => {
    await useTaskStore.getState().importCompletedTask({ ...legacy, markdown: [legacy.markdown[0]] }, 1)
  })
  expect(await screen.findByRole('heading', { name: 'Server version' })).toBeTruthy()
  view.unmount()
  await useTaskStore.persist.rehydrate()
  render(<MarkdownViewer content="" status="success" />)
  expect(await screen.findByRole('heading', { name: 'Server version' })).toBeTruthy()
  await act(async () => {
    useTaskStore.getState().updateTaskContent(legacy.id, { markdown: '# New local edit' })
  })
  expect(await screen.findByRole('heading', { name: 'New local edit' })).toBeTruthy()
})

it.each(['INTERRUPTED', 'CANCELLED'] as const)('renders explicit terminal state for %s without a loading spinner', async status => {
  useTaskStore.setState({ tasks: [{ ...legacy, status, markdown: '' }] })
  render(<MarkdownViewer content="" status="loading" />)
  expect(await screen.findByText(status === 'INTERRUPTED' ? '笔记生成已中断' : '笔记生成已取消')).toBeTruthy()
  expect(screen.queryByText('正在生成笔记，请稍候…')).toBeNull()
})

it('shows connection loss without turning the current stage into a failed task', async () => {
  useTaskStore.setState({ tasks: [{ ...legacy, status: 'SUMMARIZING' }], connections: { [legacy.id]: 'offline' } })
  render(<MarkdownViewer content="" status="loading" />)
  expect(await screen.findByText(/连接中断/)).toBeTruthy()
  await act(async () => useTaskStore.getState().setTaskConnection(legacy.id, 'reconnecting'))
  expect(screen.getByText(/正在重连/)).toBeTruthy()
  expect(screen.queryByText('笔记生成失败')).toBeNull()
})


it('shows the caught retry error without an unhandled rejected promise', async () => {
  useTaskStore.setState({ tasks: [{ ...legacy, status: 'FAILED', markdown: '' }] })
  const retry = vi.spyOn(useTaskStore.getState(), 'retryTask').mockRejectedValue(new Error('retry request rejected'))
  const notify = vi.spyOn(toast, 'error').mockReturnValue('error-toast')
  try {
    render(<MarkdownViewer content="" status="failed" />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('retry request rejected'))
  } finally {
    retry.mockRestore()
    notify.mockRestore()
  }
})
