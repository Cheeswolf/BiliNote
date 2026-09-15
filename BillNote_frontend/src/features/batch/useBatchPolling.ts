import { useEffect } from 'react'
import { isPollingNetworkError, pollingErrorMessage } from '@/utils/polling'
import { getBatch } from './api'
import { useBatchStore } from './store'
import { isTerminalBatch } from './types'
import type { BatchDetail } from './types'

// Keep a single request/import lane across detail unmounts and remounts.
let inFlight: Promise<void> | null = null

export const useBatchPolling = (batchId: string | null | undefined, interval = 3000, refreshKey = 0) => {
  const detailRevision = useBatchStore(state => batchId ? (state.detailRevisions[batchId] ?? 0) : 0)
  useEffect(() => {
    if (!batchId) return
    let cancelled = false
    const isStale = () => cancelled ||
      (useBatchStore.getState().detailRevisions[batchId] ?? 0) !== detailRevision
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const baseDelay = Math.max(1, interval)
    // Every opening revalidates once; only this effect's verified terminal detail
    // may be reused for result-import retries.
    let completed: BatchDetail | null = null
    const poll = async () => {
      // Keep a changing selection and React StrictMode from overlapping requests.
      while (inFlight) await inFlight
      if (isStale()) return
      const run = async () => {
        let retry = false
        try {
          if (useBatchStore.getState().connection !== 'online')
            useBatchStore.getState().setConnection('reconnecting')
          const detail = completed ?? (await getBatch(batchId, { suppressToast: true }))
          if (isStale()) return
          useBatchStore.setState({ active: detail, connection: 'online', error: null })
          if (isTerminalBatch(detail.status)) completed = detail
          useBatchStore.getState().notifyTerminalOutcome(detail)
          await useBatchStore.getState().importSuccessfulTasks(detail)
          failures = 0
          retry = !completed
        } catch (error) {
          if (isStale()) return
          failures += 1
          useBatchStore.setState({
            connection: isPollingNetworkError(error) ? 'offline' : 'online',
            error: pollingErrorMessage(error),
          })
          retry = true
        } finally {
          if (!isStale() && retry)
            timer = setTimeout(
              () => {
                void poll()
              },
              Math.min(baseDelay * 2 ** Math.min(failures, 10), 30000)
            )
        }
      }
      const request = run()
      inFlight = request
      await request
      if (inFlight === request) inFlight = null
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
        if (!inFlight) void poll()
      }
    })
    void poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
      unsubscribe()
    }
  }, [batchId, interval, refreshKey, detailRevision])
}
