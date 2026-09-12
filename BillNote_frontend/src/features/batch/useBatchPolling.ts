import { useEffect, useRef } from 'react'
import { isPollingNetworkError, pollingErrorMessage } from '@/utils/polling'
import { getBatch } from './api'
import { useBatchStore } from './store'
import { isTerminalBatch } from './types'
import type { BatchDetail } from './types'

export const useBatchPolling = (batchId: string | null | undefined, interval = 3000) => {
  const inFlight = useRef<Promise<void> | null>(null)
  useEffect(() => {
    if (!batchId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const baseDelay = Math.max(1, interval)
    const cached = useBatchStore.getState().active
    let completed: BatchDetail | null =
      cached?.id === batchId && isTerminalBatch(cached.status) ? cached : null
    const poll = async () => {
      // Keep a changing selection and React StrictMode from overlapping requests.
      while (inFlight.current) await inFlight.current
      if (cancelled) return
      const run = async () => {
        let retry = false
        try {
          if (useBatchStore.getState().connection !== 'online')
            useBatchStore.getState().setConnection('reconnecting')
          const detail = completed ?? (await getBatch(batchId, { suppressToast: true }))
          if (cancelled) return
          useBatchStore.setState({ active: detail, connection: 'online', error: null })
          if (isTerminalBatch(detail.status)) completed = detail
          await useBatchStore.getState().importSuccessfulTasks(detail)
          failures = 0
          retry = !completed
        } catch (error) {
          if (cancelled) return
          failures += 1
          useBatchStore.setState({
            connection: isPollingNetworkError(error) ? 'offline' : 'online',
            error: pollingErrorMessage(error),
          })
          retry = true
        } finally {
          if (!cancelled && retry)
            timer = setTimeout(
              () => {
                void poll()
              },
              Math.min(baseDelay * 2 ** Math.min(failures, 10), 30000)
            )
        }
      }
      const request = run()
      inFlight.current = request
      await request
      if (inFlight.current === request) inFlight.current = null
    }
    const unsubscribe = useBatchStore.subscribe((state, previous) => {
      if (
        state.active?.id === batchId &&
        previous.active?.id === batchId &&
        isTerminalBatch(previous.active.status) &&
        !isTerminalBatch(state.active.status)
      ) {
        completed = null
        failures = 0
        clearTimeout(timer)
        // An active cycle will schedule the next poll after its import settles.
        if (!inFlight.current) void poll()
      }
    })
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
    }
  }, [batchId, interval])
}
