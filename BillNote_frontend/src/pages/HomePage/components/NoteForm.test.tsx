import { beforeAll, afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useTaskStore } from '@/store/taskStore'
import { useModelStore } from '@/store/modelStore'
import { fetchEnableModels } from '@/services/model'
import { generateNote } from '@/services/note'
import NoteForm from './NoteForm'
vi.mock('@/services/model', () => ({
  fetchEnableModels: vi.fn(), fetchModels: vi.fn(), addModel: vi.fn(),
  fetchEnableModelById: vi.fn(), deleteModelById: vi.fn(),
}))
vi.mock('@/services/note', () => ({ generateNote: vi.fn(), get_task_status: vi.fn(), delete_task: vi.fn() }))
beforeAll(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }))
afterAll(() => vi.unstubAllGlobals())
afterEach(() => vi.restoreAllMocks())
beforeEach(async () => {
  vi.clearAllMocks()
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], currentTaskId: null, recoveryTask: null })
  const models = [{ id: 'model-1', model_name: 'test-model', provider_id: 'provider-1' }]
  useModelStore.setState({ modelList: models })
  vi.mocked(fetchEnableModels).mockResolvedValue(models)
  vi.mocked(generateNote).mockImplementation(async request => ({ task_id: request.task_id! }))
})
it('preserves the single-note default payload and selects its newly created history item', async () => {
  render(<MemoryRouter><NoteForm /></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('请输入视频网站链接'), { target: { value: 'https://b23.tv/a' } })
  fireEvent.submit(screen.getByRole('button', { name: '生成笔记' }).closest('form')!)
  await waitFor(() => expect(generateNote).toHaveBeenCalledWith({
    video_url: 'https://b23.tv/a', platform: 'bilibili', quality: 'medium',
    model_name: 'test-model', provider_id: 'provider-1', task_id: expect.any(String), create_only: true,
    style: 'minimal', format: [], video_interval: 6, grid_size: [2, 2],
  }))
  expect(useTaskStore.getState().currentTaskId).toBe(vi.mocked(generateNote).mock.calls[0][0].task_id)
})




it('uses shared generation controls while preserving the single-note submission route', async () => {
  render(<MemoryRouter><NoteForm /></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('请输入视频网站链接'), { target: { value: 'https://b23.tv/a' } })
  fireEvent.change(screen.getByLabelText('音频质量'), { target: { value: 'slow' } })
  fireEvent.submit(screen.getByRole('button', { name: '生成笔记' }).closest('form')!)
  await waitFor(() => expect(generateNote).toHaveBeenCalledWith(expect.objectContaining({
    quality: 'slow', platform: 'bilibili', model_name: 'test-model', provider_id: 'provider-1',
  })))
})

it('restores the saved provider for duplicate model names and regenerates with that provider', async () => {
  const models = [
    { id: 1, provider_id: 'provider-1', model_name: 'shared-model' },
    { id: 2, provider_id: 'provider-2', model_name: 'shared-model' },
  ]
  useModelStore.setState({ modelList: models })
  vi.mocked(fetchEnableModels).mockResolvedValue(models)
  useTaskStore.getState().addPendingTask('saved-note', 'bilibili', {
    video_url: 'https://b23.tv/a', platform: 'bilibili', quality: 'medium',
    model_name: 'shared-model', provider_id: 'provider-2',
    style: 'minimal', format: [], video_interval: 6, grid_size: [2, 2],
  })
  useTaskStore.getState().updateTaskContent('saved-note', { status: 'SUCCESS', markdown: '# Saved note' })
  render(<MemoryRouter><NoteForm /></MemoryRouter>)
  expect((screen.getByLabelText('模型选择') as HTMLSelectElement).value).toBe('2')
  fireEvent.submit(screen.getByRole('button', { name: '重新生成' }).closest('form')!)
  await waitFor(() => expect(generateNote).toHaveBeenCalledWith(expect.objectContaining({
    model_name: 'shared-model', provider_id: 'provider-2', task_id: expect.any(String), parent_task_id: 'saved-note', create_only: true,
  })))
  expect(useTaskStore.getState().getCurrentTask()?.formData.provider_id).toBe('provider-2')
})

it('shows unavailable history without creating a paid task', async () => {
  vi.spyOn(useTaskStore.persist, 'hasHydrated').mockReturnValue(false)
  vi.spyOn(useTaskStore.persist, 'rehydrate').mockResolvedValue(undefined)
  render(<MemoryRouter><NoteForm /></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('请输入视频网站链接'), { target: { value: 'https://b23.tv/a' } })
  fireEvent.submit(screen.getByRole('button', { name: '生成笔记' }).closest('form')!)
  expect((await screen.findByRole('alert')).textContent).toMatch(/storage/)
  expect(generateNote).not.toHaveBeenCalled()
})

it('shows a confirmed task ID and save-only recovery action if IndexedDB fails', async () => {
  const write = vi.spyOn(useTaskStore.persist.getOptions().storage!, 'setItem').mockRejectedValueOnce(new Error('disk full'))
  render(<MemoryRouter><NoteForm /></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('请输入视频网站链接'), { target: { value: 'https://b23.tv/a' } })
  fireEvent.submit(screen.getByRole('button', { name: '生成笔记' }).closest('form')!)
  const recover = await screen.findByRole('button', { name: '重试保存任务记录' })
  expect(screen.getByRole('alert').textContent).toContain(useTaskStore.getState().recoveryTask!.id)
  write.mockRestore()
  fireEvent.click(recover)
  await waitFor(() => expect(screen.queryByRole('button', { name: '重试保存任务记录' })).toBeNull())
  expect(generateNote).toHaveBeenCalledTimes(1)
})
