export class ResultUnavailableError extends Error {}
export class TaskStorageError extends Error {}

// The request interceptor unwraps HTTP/application errors and marks transport
// failures with code -1. Plain Errors cover rejected browser transports too.
export const isPollingNetworkError = (error: unknown): boolean => {
  if (error instanceof ResultUnavailableError || error instanceof TaskStorageError) return false
  if (error instanceof Error) return true
  return typeof error === 'object' && error !== null && 'code' in error && error.code === -1
}

export const pollingErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (
    typeof error === 'object' &&
    error !== null &&
    'msg' in error &&
    typeof error.msg === 'string'
  )
    return error.msg
  return 'Refresh failed'
}

// The legacy task-status route returns R.error(message, code=500, data=null)
// when its persisted status file explicitly says FAILED. Transport errors use -1.
export const isLegacyTaskFailure = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 500 &&
  'data' in error &&
  error.data === null &&
  'msg' in error &&
  typeof error.msg === 'string'
