import { StrictMode } from 'react'
import toast, { useToasterStore } from 'react-hot-toast'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render, renderHook, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { listBatches, getBatch } from './features/batch/api'
import { useBatchStore } from './features/batch/store'
import { detailWithJob } from './features/batch/testFixtures'
vi.mock('@/hooks/useTaskPolling', () => ({ useTaskPolling: () => {} }))
vi.mock('@/hooks/useCheckBackend', () => ({
  useCheckBackend: () => ({ initialized: true, loading: false, failed: false }),
}))
vi.mock('@/services/system', () => ({ systemCheck: vi.fn() }))
vi.mock('@/components/BackendInitDialog', () => ({ default: () => null }))
vi.mock('@/components/SystemDiagnostic/StartupBanner', () => ({ default: () => null }))
vi.mock('@/components/BackendHealth/BackendHealthIndicator', () => ({ default: () => null }))
vi.mock('./pages/HomePage/Home.tsx', () => ({ HomePage: () => <p>单视频首页</p> }))
vi.mock('@/pages/NotFoundPage', () => ({ default: () => <p>未注册路由</p> }))
vi.mock('./features/batch/api', () => ({ listBatches: vi.fn(), getBatch: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  toast.remove()
  vi.mocked(listBatches).mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 })
  useBatchStore.setState(useBatchStore.getInitialState(), true)
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
  localStorage.setItem('bilinote-onboarded', '1')
})
it('registers the creation page inside the Tauri hash router', async () => {
  window.history.replaceState({}, '', '/#/batch/new')
  render(<App />)
  expect(await screen.findByLabelText('视频链接')).toBeTruthy()
})
it('navigates from hash-routed center to a real batch detail and back to the existing home route', async () => {
  const detail = { ...detailWithJob('FAILED'), status: 'PARTIAL' as const }
  vi.mocked(listBatches).mockResolvedValue({ items: [detail], total: 1, page: 1, page_size: 20 })
  vi.mocked(getBatch).mockResolvedValue(detail)
  window.history.replaceState({}, '', '/#/batch')
  render(<App />)
  const card = await screen.findByRole('link', { name: /Lecture notes/ })
  expect(card.getAttribute('href')).toBe('#/batch/batch-1')
  await userEvent.click(card)
  expect(await screen.findByText('失败')).toBeTruthy()
  await userEvent.click(screen.getByRole('link', { name: '单个视频' }))
  expect(await screen.findByText('单视频首页')).toBeTruthy()
  expect(window.location.hash).toBe('#/')
})
it('preserves the web home index route', async () => {
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  window.history.replaceState({}, '', '/')
  render(<App />)
  expect(await screen.findByText('单视频首页')).toBeTruthy()
})

afterEach(() => { vi.useRealTimers(); toast.remove() })

it.each(['/batch', '/'])('announces completion on %s after leaving detail under StrictMode', async destination => {
  const running = detailWithJob('SUMMARIZING')
  const done = { ...detailWithJob('FAILED'), status: 'PARTIAL' as const }
  vi.mocked(listBatches).mockResolvedValue({ items: [running], total: 1, page: 1, page_size: 100 })
  vi.mocked(getBatch).mockResolvedValue(running)
  window.history.replaceState({}, '', '/#/batch/batch-1')
  const messages = renderHook(() => useToasterStore().toasts)
  render(<StrictMode><App /></StrictMode>)
  await screen.findByRole('heading', { name: 'Lecture notes' })
  await userEvent.click(screen.getByRole('link', { name: destination === '/batch' ? '批量任务中心' : '单个视频' }))
  if (destination === '/') await screen.findByText('单视频首页')
  else await screen.findByRole('heading', { name: '批量任务中心' })
  vi.mocked(listBatches).mockResolvedValue({ items: [done], total: 1, page: 1, page_size: 100 })
  vi.mocked(getBatch).mockResolvedValue(done)
  await vi.waitFor(() => expect(messages.result.current).toHaveLength(1), { timeout: 7000, interval: 100 })
  expect(messages.result.current[0].message).toContain('部分异常')
}, 12000)
