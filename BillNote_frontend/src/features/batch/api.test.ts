import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'
import request from '@/utils/request'
import toast from 'react-hot-toast'
import { get_task_status } from '@/services/note'
import {
  previewBatch,
  submitBatch,
  listBatches,
  getBatch,
  pauseBatch,
  resumeBatch,
  retryFailed,
  cancelPending,
} from './api'
import { detailWithJob } from './testFixtures'
const original = request.defaults.adapter
let calls: InternalAxiosRequestConfig[]
let response: unknown
beforeEach(() => {
  calls = []
  response = detailWithJob()
  request.defaults.adapter = (async config => {
    calls.push(config)
    return {
      data: { code: 0, msg: 'success', data: response },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    }
  }) satisfies AxiosAdapter
})
afterEach(() => {
  request.defaults.adapter = original
  vi.restoreAllMocks()
})
it('uses the batch routes, unwraps envelopes, and preserves selected item order', async () => {
  response = { items: [] }
  expect(await previewBatch({ lines: ['one', 'two'], expand_multipart: false })).toEqual({
    items: [],
  })
  expect(JSON.parse(calls[0].data)).toEqual({ lines: ['one', 'two'], expand_multipart: false })
  const payload = {
    request_id: 'request-1',
    name: 'notes',
    source_label: 'links',
    items: [
      {
        original_url: 'https://youtu.be/two',
        normalized_url: 'https://www.youtube.com/watch?v=two',
        platform: 'youtube',
        resource_key: 'youtube:two',
        title: null,
        cover_url: null,
        duration: null,
        valid: true,
        error: null,
      },
      {
        original_url: 'https://youtu.be/one',
        normalized_url: 'https://www.youtube.com/watch?v=one',
        platform: 'youtube',
        resource_key: 'youtube:one',
        title: null,
        cover_url: null,
        duration: null,
        valid: true,
        error: null,
      },
    ],
    settings: { quality: 'fast' as const, model_name: 'm', provider_id: 'p' },
  }
  response = { batch_id: 'batch-1', task_ids: ['one', 'two'] }
  expect(await submitBatch(payload)).toEqual({ batch_id: 'batch-1', task_ids: ['one', 'two'] })
  expect(JSON.parse(calls[1].data)).toEqual(payload)
  expect(
    JSON.parse(calls[1].data).items.map((item: { resource_key: string }) => item.resource_key)
  ).toEqual(['youtube:two', 'youtube:one'])
  await listBatches(2, 10)
  await getBatch('id/with slash')
  await pauseBatch('batch-1')
  await resumeBatch('batch-1')
  await retryFailed('batch-1')
  await cancelPending('batch-1')
  expect(calls.map(c => [c.method, c.url])).toEqual([
    ['post', '/batch/preview'],
    ['post', '/batch/submit'],
    ['get', '/batch'],
    ['get', '/batch/id%2Fwith%20slash'],
    ['post', '/batch/batch-1/pause'],
    ['post', '/batch/batch-1/resume'],
    ['post', '/batch/batch-1/retry-failed'],
    ['post', '/batch/batch-1/cancel-pending'],
  ])
  expect(calls[2].params).toEqual({ page: 2, page_size: 10 })
  expect(calls.slice(4).every(c => c.data === undefined && !c.suppressToast)).toBe(true)
})
it('suppresses polling errors but retains normal mutation error feedback', async () => {
  const errorToast = vi.spyOn(toast, 'error')
  request.defaults.adapter = async config => {
    throw { config, response: { data: { code: 500, msg: 'backend unavailable', data: null } } }
  }
  await expect(getBatch('batch-1', { suppressToast: true })).rejects.toMatchObject({ code: 500 })
  await expect(get_task_status('task-1', { suppressToast: true })).rejects.toMatchObject({
    code: 500,
  })
  expect(errorToast).not.toHaveBeenCalled()
  await expect(pauseBatch('batch-1')).rejects.toMatchObject({ code: 500 })
  expect(errorToast).toHaveBeenCalledTimes(1)
})
