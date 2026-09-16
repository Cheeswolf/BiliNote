import request from '@/utils/request'
import type {
  BatchDetail,
  BatchList,
  BatchPreviewItem,
  BatchPreviewRequest,
  BatchSubmitRequest,
  BatchSubmitResult,
} from './types'
const batchPath = (id: string) => '/batch/' + encodeURIComponent(id)
export const previewBatch = (data: BatchPreviewRequest) =>
  request.post<unknown, { items: BatchPreviewItem[] }>('/batch/preview', data)
export const submitBatch = (data: BatchSubmitRequest) =>
  request.post<unknown, BatchSubmitResult>('/batch/submit', data)
export const listBatches = (page = 1, pageSize = 20, options: { suppressToast?: boolean } = {}) =>
  request.get<unknown, BatchList>('/batch', { ...options, params: { page, page_size: pageSize } })
export const getBatch = (id: string, options: { suppressToast?: boolean } = {}) =>
  request.get<unknown, BatchDetail>(batchPath(id), options)
export const pauseBatch = (id: string) =>
  request.post<unknown, BatchDetail>(batchPath(id) + '/pause')
export const resumeBatch = (id: string) =>
  request.post<unknown, BatchDetail>(batchPath(id) + '/resume')
export const retryFailed = (id: string) =>
  request.post<unknown, BatchDetail>(batchPath(id) + '/retry-failed')
export const cancelPending = (id: string) =>
  request.post<unknown, BatchDetail>(batchPath(id) + '/cancel-pending')
