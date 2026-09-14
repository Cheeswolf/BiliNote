import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest'
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
beforeEach(async () => {
  vi.clearAllMocks()
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], currentTaskId: null })
  const models = [{ id: 'model-1', model_name: 'test-model', provider_id: 'provider-1' }]
  useModelStore.setState({ modelList: models })
  vi.mocked(fetchEnableModels).mockResolvedValue(models as never)
  vi.mocked(generateNote).mockResolvedValue({ task_id: 'single' } as never)
})
it('preserves the single-note default payload and selects its newly created history item', async () => {
  render(<MemoryRouter><NoteForm /></MemoryRouter>)
  fireEvent.change(screen.getByPlaceholderText('请输入视频网站链接'), { target: { value: 'https://b23.tv/a' } })
  fireEvent.submit(screen.getByRole('button', { name: '生成笔记' }).closest('form')!)
  await waitFor(() => expect(generateNote).toHaveBeenCalledWith({
    video_url: 'https://b23.tv/a', platform: 'bilibili', quality: 'medium',
    model_name: 'test-model', provider_id: 'provider-1', task_id: '',
    style: 'minimal', format: [], video_interval: 6, grid_size: [2, 2],
  }))
  expect(useTaskStore.getState().currentTaskId).toBe('single')
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
