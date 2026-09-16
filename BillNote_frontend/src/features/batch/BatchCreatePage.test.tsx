import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { useModelStore } from '@/store/modelStore'
import { fetchEnableModels } from '@/services/model'
import { previewBatch, submitBatch } from './api'
import type { BatchPreviewItem } from './types'
import BatchCreatePage from './BatchCreatePage'
import { AxiosError } from 'axios'
import request from '@/utils/request'
import toast, { useToasterStore } from 'react-hot-toast'
import { useBatchStore } from './store'
import { useTaskStore } from '@/store/taskStore'
import { get_task_status } from '@/services/note'
import { getBatch } from './api'
import { useBatchPolling } from './useBatchPolling'
import { detailWithJob, successfulResult } from './testFixtures'

vi.mock('./api', () => ({ previewBatch: vi.fn(), submitBatch: vi.fn(), getBatch: vi.fn() }))
vi.mock('@/services/model', () => ({
  fetchEnableModels: vi.fn(), fetchModels: vi.fn(), addModel: vi.fn(),
  fetchEnableModelById: vi.fn(), deleteModelById: vi.fn(),
}))
vi.mock('@/services/note', () => ({ get_task_status: vi.fn(), generateNote: vi.fn(), delete_task: vi.fn() }))
const originalAdapter = request.defaults.adapter
afterEach(() => { request.defaults.adapter = originalAdapter })
const item = (n: number): BatchPreviewItem => ({
  original_url: 'https://b23.tv/a', normalized_url: 'https://www.bilibili.com/video/BV1test?p=' + n,
  platform: 'bilibili', resource_key: 'bilibili:BV1test:p' + n, title: '课程 · P' + n,
  cover_url: 'https://example.com/cover.jpg', duration: 61 + n, valid: true, error: null,
})
const invalid: BatchPreviewItem = {
  original_url: 'invalid', normalized_url: '', platform: null, resource_key: '',
  title: null, cover_url: null, duration: null, valid: false, error: '无效链接',
}
const mount = () => render(
  <MemoryRouter initialEntries={['/batch/new']}><Routes>
    <Route path="/batch/new" element={<BatchCreatePage />} />
    <Route path="/batch" element={<p>任务中心列表</p>} />
    <Route path="/batch/:batchId" element={<p>批次已创建</p>} />
  </Routes></MemoryRouter>
)
beforeEach(async () => {
  vi.clearAllMocks()
  toast.remove()
  localStorage.clear()
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  await useTaskStore.persist.rehydrate()
  useTaskStore.setState({ tasks: [], currentTaskId: null, batchImportedAttempts: {} })
  const models = [{ id: 'model-1', provider_id: 'provider-1', model_name: 'test-model' }]
  useModelStore.setState({ modelList: models })
  vi.mocked(fetchEnableModels).mockResolvedValue(models)
  vi.mocked(previewBatch).mockResolvedValue({ items: [item(1), item(2), item(3), invalid] })
  vi.mocked(submitBatch).mockResolvedValue({ batch_id: 'created', task_ids: ['a', 'b'] })
})
const parse = async () => {
  fireEvent.change(screen.getByLabelText('视频链接'), { target: { value: 'https://b23.tv/a\ninvalid' } })
  await userEvent.click(screen.getByRole('button', { name: '解析链接' }))
  await screen.findByText('课程 · P1')
}
it('previews multiple lines, removes invalid rows, and submits selected parts in displayed order', async () => {
  mount()
  await parse()
  expect(previewBatch).toHaveBeenCalledWith({ lines: ['https://b23.tv/a', 'invalid'], expand_multipart: true })
  expect(screen.getByRole('img', { name: '课程 · P1' })).toBeTruthy()
  expect(screen.getByText('01:02')).toBeTruthy()
  expect((screen.getByRole('checkbox', { name: /invalid/ }) as HTMLInputElement).disabled).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: '移除无效项' }))
  expect(screen.queryByText('无效链接')).toBeNull()
  await userEvent.click(screen.getByRole('checkbox', { name: '选择 课程 · P2' }))
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  const start = screen.getByRole('button', { name: '开始生成 2 条笔记' })
  expect((start as HTMLButtonElement).disabled).toBe(false)
  await userEvent.click(start)
  await screen.findByText('批次已创建')
  const payload = vi.mocked(submitBatch).mock.calls[0][0]
  expect(payload.items).toEqual([item(1), item(3)])
  expect(payload.settings).toMatchObject({
    quality: 'medium', model_name: 'test-model', provider_id: 'provider-1',
    style: 'minimal', format: [], video_interval: 6, grid_size: [2, 2],
  })
  expect(payload.settings).not.toHaveProperty('api_key')
})
it('selects all, inverts, clears, and removes an individual part without changing order', async () => {
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '清空选择' }))
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: '反选' }))
  expect((screen.getByRole('checkbox', { name: '选择 课程 · P2' }) as HTMLInputElement).checked).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: '移除 课程 · P2' }))
  await userEvent.click(screen.getByRole('button', { name: '全选' }))
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByRole('button', { name: '开始生成 2 条笔记' })).toBeTruthy()
})
it('blocks 101 selected items until the selection is reduced to 100', async () => {
  vi.mocked(previewBatch).mockResolvedValue({ items: Array.from({ length: 101 }, (_, i) => item(i + 1)) })
  mount()
  await parse()
  expect(screen.getByRole('alert').textContent).toMatch(/最多.*100/)
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true)
  await userEvent.click(screen.getByRole('checkbox', { name: '选择 课程 · P101' }))
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect((screen.getByRole('button', { name: '开始生成 100 条笔记' }) as HTMLButtonElement).disabled).toBe(false)
})
it('reuses the UUID and frozen payload after an uncertain submit, including after editing settings', async () => {
  vi.mocked(submitBatch).mockRejectedValueOnce(new Error('timeout'))
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await screen.findByRole('alert')
  const first = vi.mocked(submitBatch).mock.calls[0][0]
  expect(first.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
  expect((screen.getByLabelText('批次名称') as HTMLInputElement).disabled).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: '重试提交' }))
  await screen.findByText('批次已创建')
  expect(vi.mocked(submitBatch).mock.calls[1][0]).toEqual(first)
})
it('invalidates parsed rows when the input is edited so stale links cannot be submitted', async () => {
  mount()
  await parse()
  fireEvent.change(screen.getByLabelText('视频链接'), { target: { value: 'https://youtu.be/new' } })
  expect(screen.queryByText('课程 · P1')).toBeNull()
  expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true)
})
it('shows parse failures and permits retry without leaving stale selections', async () => {
  vi.mocked(previewBatch).mockRejectedValueOnce(new Error('preview unavailable'))
  mount()
  fireEvent.change(screen.getByLabelText('视频链接'), { target: { value: 'https://b23.tv/a' } })
  await userEvent.click(screen.getByRole('button', { name: '解析链接' }))
  expect((await screen.findByRole('alert')).textContent).toContain('preview unavailable')
  await userEvent.click(screen.getByRole('button', { name: '解析链接' }))
  await screen.findByText('课程 · P1')
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})
it('requires a configured model and validates video-understanding numeric settings', async () => {
  useModelStore.setState({ modelList: [] })
  vi.mocked(fetchEnableModels).mockResolvedValue([])
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByRole('link', { name: '请先添加模型' })).toBeTruthy()
  expect((screen.getByRole('button', { name: '开始生成 3 条笔记' }) as HTMLButtonElement).disabled).toBe(true)
})
it('emits shared generation choices without leaking provider credentials', async () => {
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.selectOptions(screen.getByLabelText('笔记风格'), 'detailed')
  await userEvent.selectOptions(screen.getByLabelText('音频质量'), 'slow')
  await userEvent.click(screen.getByRole('checkbox', { name: '启用视频理解' }))
  fireEvent.change(screen.getByLabelText('采样间隔（秒）'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText('拼图列数'), { target: { value: '3' } })
  await userEvent.click(screen.getByRole('checkbox', { name: '原片截图' }))
  await userEvent.click(screen.getByRole('checkbox', { name: '原片跳转' }))
  await userEvent.type(screen.getByLabelText('备注'), '保留例子')
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await screen.findByText('批次已创建')
  expect(vi.mocked(submitBatch).mock.calls[0][0].settings).toMatchObject({
    quality: 'slow', style: 'detailed', video_understanding: true, video_interval: 8,
    grid_size: [3, 2], format: ['screenshot', 'link'], extras: '保留例子',
  })
})

it('selects numeric model IDs and preserves provider identity when names are shared', async () => {
  const models = [
    { id: 1, provider_id: 'provider-1', model_name: 'shared-model' },
    { id: 2, provider_id: 'provider-2', model_name: 'shared-model' },
  ]
  useModelStore.setState({ modelList: models })
  vi.mocked(fetchEnableModels).mockResolvedValue(models)
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.selectOptions(screen.getByLabelText('模型选择'), '2')
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await screen.findByText('批次已创建')
  expect(vi.mocked(submitBatch).mock.calls[0][0].settings).toMatchObject({
    model_name: 'shared-model', provider_id: 'provider-2',
  })
})
it('allows correcting a rejected validation request and starts a fresh creation attempt', async () => {
  vi.mocked(submitBatch).mockRejectedValueOnce({ code: 400, msg: '模型不可用', data: null })
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await screen.findByRole('alert')
  expect((screen.getByLabelText('批次名称') as HTMLInputElement).disabled).toBe(false)
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await screen.findByText('批次已创建')
  expect(vi.mocked(submitBatch).mock.calls[1][0].request_id).not.toBe(vi.mocked(submitBatch).mock.calls[0][0].request_id)
})
it('blocks out-of-range intervals and noninteger grid sizes before submitting', async () => {
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('checkbox', { name: '启用视频理解' }))
  fireEvent.change(screen.getByLabelText('采样间隔（秒）'), { target: { value: '31' } })
  expect((screen.getByRole('button', { name: '开始生成 3 条笔记' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('采样间隔（秒）'), { target: { value: '6' } })
  fireEvent.change(screen.getByLabelText('拼图列数'), { target: { value: '1.5' } })
  expect((screen.getByRole('button', { name: '开始生成 3 条笔记' }) as HTMLButtonElement).disabled).toBe(true)
  expect(submitBatch).not.toHaveBeenCalled()
})

it('displays FastAPI validation reasons and unlocks settings for correction', async () => {
  vi.mocked(submitBatch).mockRejectedValueOnce({ status: 422, detail: [
    { loc: ['body', 'settings', 'provider_id'], type: 'string_type', msg: 'Input should be a valid string' },
  ] })
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Input should be a valid string')
  expect((screen.getByLabelText('批次名称') as HTMLInputElement).disabled).toBe(false)
})
it('rejects fractional sampling intervals required to be integers by the batch API', async () => {
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('checkbox', { name: '启用视频理解' }))
  fireEvent.change(screen.getByLabelText('采样间隔（秒）'), { target: { value: '1.5' } })
  expect((screen.getByRole('button', { name: '开始生成 3 条笔记' }) as HTMLButtonElement).disabled).toBe(true)
})

it.each([
  { status: 400, detail: 'Provider is disabled' },
  { status: 422, detail: 'Invalid generation settings' },
  { status: 422, detail: [{ loc: ['body', 'settings', 'provider_id'], type: 'string_type', msg: 'Input should be a valid string' }] },
])('releases the attempt after actual HTTP $status validation through the request interceptor', async ({ status, detail }) => {
  const api = await vi.importActual<typeof import('./api')>('./api')
  vi.mocked(submitBatch).mockImplementation(api.submitBatch)
  const sent: string[] = []
  request.defaults.adapter = async config => {
    sent.push(config.data)
    if (sent.length === 1) {
      throw new AxiosError('Request failed', AxiosError.ERR_BAD_REQUEST, config, undefined, {
        status, statusText: 'Validation rejected', headers: {}, config, data: { detail },
      })
    }
    return { status: 200, statusText: 'OK', headers: {}, config, data: {
      code: 0, msg: 'ok', data: { batch_id: 'created', task_ids: ['a'] },
    } }
  }
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  expect((await screen.findByRole('alert')).textContent).toContain(typeof detail === 'string' ? detail : detail[0].msg)
  const name = screen.getByLabelText('批次名称') as HTMLInputElement
  expect(name.disabled).toBe(false)
  fireEvent.change(name, { target: { value: '修正后的批次' } })
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await screen.findByText('批次已创建')
  expect(JSON.parse(sent[1]).request_id).not.toBe(JSON.parse(sent[0]).request_id)
  expect(JSON.parse(sent[1]).name).toBe('修正后的批次')
})

it.each([500, undefined])('keeps the exact attempt for an unknown outcome with status %s through the interceptor', async status => {
  const api = await vi.importActual<typeof import('./api')>('./api')
  vi.mocked(submitBatch).mockImplementation(api.submitBatch)
  const sent: string[] = []
  request.defaults.adapter = async config => {
    sent.push(config.data)
    if (sent.length === 1) {
      throw new AxiosError('Request failed', AxiosError.ERR_NETWORK, config, undefined,
        status ? { status, statusText: 'Server error', headers: {}, config,
          data: { detail: [{ msg: 'Unable to confirm creation' }] } } : undefined)
    }
    return { status: 200, statusText: 'OK', headers: {}, config, data: {
      code: 0, msg: 'ok', data: { batch_id: 'created', task_ids: ['a'] },
    } }
  }
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await screen.findByRole('alert')
  expect((screen.getByLabelText('批次名称') as HTMLInputElement).disabled).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: '重试提交' }))
  await screen.findByText('批次已创建')
  expect(sent[1]).toBe(sent[0])
})

it('does not navigate away from the user destination when a submit succeeds after leaving', async () => {
  let finish!: (result: { batch_id: string; task_ids: string[] }) => void
  vi.mocked(submitBatch).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await userEvent.click(screen.getByRole('link', { name: '批量任务中心' }))
  await screen.findByText('任务中心列表')
  await act(async () => finish({ batch_id: 'created', task_ids: ['a'] }))
  expect(screen.getByText('任务中心列表')).toBeTruthy()
  expect(screen.queryByText('批次已创建')).toBeNull()
  expect(useBatchStore.getState().outcomeReceipts?.find(receipt => receipt.batchId === 'created')?.tracked).toBe(true)
})

it.each(['SUCCESS', 'FAILED'] as const)('announces an immediate %s before any nonterminal detail read', async status => {
  const detail = { ...detailWithJob(status, 'created'), status: status === 'SUCCESS' ? 'COMPLETED' as const : 'PARTIAL' as const }
  vi.mocked(getBatch).mockResolvedValue(detail)
  vi.mocked(get_task_status).mockResolvedValue(successfulResult)
  function TerminalPage() {
    useBatchPolling('created', 10)
    const { toasts } = useToasterStore()
    return <p>{toasts.length ? String(toasts[0].message) : 'No summary'}</p>
  }
  render(<MemoryRouter initialEntries={['/batch/new']}><Routes>
    <Route path="/batch/new" element={<BatchCreatePage />} />
    <Route path="/batch/:batchId" element={<TerminalPage />} />
  </Routes></MemoryRouter>)
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await screen.findByText(/成功.*失败/)
  await waitFor(() => expect(useTaskStore.getState().tasks).toHaveLength(status === 'SUCCESS' ? 1 : 0))
})

it('does not track an abandoned submission whose server creation was never confirmed', async () => {
  let reject!: (error: Error) => void
  vi.mocked(submitBatch).mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
  mount()
  await parse()
  await userEvent.click(screen.getByRole('button', { name: '下一步' }))
  await userEvent.click(screen.getByRole('button', { name: '开始生成 3 条笔记' }))
  await userEvent.click(screen.getByRole('link', { name: '批量任务中心' }))
  await act(async () => reject(new Error('connection lost')))
  expect(screen.getByText('任务中心列表')).toBeTruthy()
  expect(useBatchStore.getState().outcomeReceipts ?? []).toEqual([])
})
