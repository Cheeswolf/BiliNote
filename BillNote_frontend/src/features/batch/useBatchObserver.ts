import { useEffect } from 'react'
import { getBatch, listBatches } from './api'
import { hasDetailReader, inBatchPollingLane } from './pollingLane'
import { useBatchStore } from './store'
import { isTerminalBatch } from './types'

// Mounted once above the router. Detail pages own their own batch; this observer
// discovers all pages and takes over when a detail reader leaves.
export function useBatchObserver(enabled = true, interval = 5000) {
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const verified = new Map<string, string>()
    const scan = async () => {
      let failed = false
      const seen = new Set<string>()
      try {
        let page = 1
        let pending: Awaited<ReturnType<typeof listBatches>>['items'] = []
        let more = true
        while (!cancelled && more) {
          await inBatchPollingLane(async () => {
            if (cancelled) return
            const list = await listBatches(page, 100, { suppressToast: true })
            if (cancelled) return
            more = list.items.length > 0 && page * list.page_size < list.total
            for (const batch of list.items) {
              seen.add(batch.id)
              if (!isTerminalBatch(batch.status))
                useBatchStore.getState().notifyTerminalOutcome({ ...batch, jobs: [] })
            }
            // Release the lane before each detail read so foreground work can run.
            pending = list.items
          })
          for (const batch of pending) {
            if (cancelled) break
            try {
              await inBatchPollingLane(async () => {
                if (cancelled || hasDetailReader(batch.id)) return
                const revision = useBatchStore.getState().detailRevisions[batch.id] ?? 0
                const version = JSON.stringify([batch.status, batch.updated_at, revision])
                if (isTerminalBatch(batch.status) && verified.get(batch.id) === version) return
                const detail = await getBatch(batch.id, { suppressToast: true })
                if (cancelled || hasDetailReader(batch.id) ||
                    (useBatchStore.getState().detailRevisions[batch.id] ?? 0) !== revision) return
                useBatchStore.getState().notifyTerminalOutcome(detail)
                // Discovery baselines history without repopulating deleted notes.
                if (useBatchStore.getState().outcomeReceipts?.some(receipt =>
                  receipt.batchId === detail.id && receipt.tracked))
                  await useBatchStore.getState().importSuccessfulTasks(detail)
                if (isTerminalBatch(detail.status)) verified.set(batch.id, version)
                else verified.delete(batch.id)
              })
            } catch { failed = true }
          }
          page += 1
        }
        for (const id of verified.keys()) if (!seen.has(id)) verified.delete(id)
      } catch { failed = true }
      if (!cancelled) {
        failures = failed ? failures + 1 : 0
        timer = setTimeout(() => { void scan() },
          Math.min(Math.max(1, interval) * 2 ** Math.min(failures, 10), 30000))
      }
    }
    void scan()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [enabled, interval])
}
