import { beforeEach, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { listBatches } from './api'
import { useBatchStore } from './store'
import { detailWithJob } from './testFixtures'
import BatchListPage from './BatchListPage'
vi.mock('./api', () => ({ listBatches: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  useBatchStore.setState(useBatchStore.getInitialState(), true)
})
it('shows current-page processing, completed and abnormal counts with linked batch cards', async () => {
  vi.mocked(listBatches).mockResolvedValue({
    items: [
      detailWithJob('SUMMARIZING', 'processing'),
      { ...detailWithJob('SUCCESS', 'completed'), status: 'COMPLETED', name: '已完成课程' },
      { ...detailWithJob('INTERRUPTED', 'recoverable'), status: 'RECOVERABLE', name: '中断课程' },
    ], total: 3, page: 1, page_size: 20,
  })
  render(<MemoryRouter><BatchListPage /></MemoryRouter>)
  await screen.findByText('已完成课程')
  expect(screen.getByText('处理中 1')).toBeTruthy()
  expect(screen.getByText('已完成 1')).toBeTruthy()
  expect(screen.getByText('异常 1')).toBeTruthy()
  expect(screen.getByRole('link', { name: /中断课程/ }).getAttribute('href')).toBe('/batch/recoverable')
  expect(screen.getByText('中断 1')).toBeTruthy()
  expect(screen.getByRole('link', { name: '新建批量任务' }).getAttribute('href')).toBe('/batch/new')
})
it('paginates the center and recovers from a failed refresh without discarding existing cards', async () => {
  vi.mocked(listBatches).mockResolvedValueOnce({
    items: [{ ...detailWithJob('SUCCESS'), status: 'COMPLETED' }], total: 21, page: 1, page_size: 20,
  }).mockRejectedValueOnce(new Error('list unavailable')).mockResolvedValue({
    items: [{ ...detailWithJob('SUCCESS', 'page-2'), status: 'COMPLETED', name: '第二页课程' }],
    total: 21, page: 2, page_size: 20,
  })
  render(<MemoryRouter><BatchListPage /></MemoryRouter>)
  await screen.findByText('Lecture notes')
  await userEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect((await screen.findByRole('alert')).textContent).toContain('list unavailable')
  expect(screen.getByText('Lecture notes')).toBeTruthy()
  await userEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText('第二页课程')
  expect(listBatches).toHaveBeenLastCalledWith(2, 20)
})
