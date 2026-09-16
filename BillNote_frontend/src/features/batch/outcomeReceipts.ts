import { isTerminalBatch } from './types'
import type { BatchDetail } from './types'

const STORAGE_KEY = 'bilinote-batch-outcomes'
const MAX_BATCHES = 200
const MAX_OUTCOMES = 8
const MAX_AGE = 30 * 24 * 60 * 60 * 1000
export interface OutcomeReceipt {
  batchId: string
  touchedAt: number
  outcomes: string[]
  pending: boolean
  tracked: boolean
}
const prune = (receipts: OutcomeReceipt[]) => receipts
  .filter(receipt => receipt.touchedAt >= Date.now() - MAX_AGE)
  // Evict historical completions before batches we have seen still in progress.
  .sort((a, b) => Number(a.pending) - Number(b.pending))
  .slice(-MAX_BATCHES)

export function readOutcomeReceipts(): OutcomeReceipt[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (saved?.version !== 1 || !Array.isArray(saved.receipts)) return []
    const receipts: OutcomeReceipt[] = []
    for (const entry of saved.receipts) {
      if (!entry || typeof entry.batchId !== 'string' || !entry.batchId ||
          !Number.isFinite(entry.touchedAt) || entry.touchedAt > Date.now() ||
          !Array.isArray(entry.outcomes) ||
          !entry.outcomes.every((outcome: unknown) => typeof outcome === 'string')) continue
      receipts.push({ batchId: entry.batchId, touchedAt: entry.touchedAt,
        outcomes: [...new Set<string>(entry.outcomes)].slice(-MAX_OUTCOMES),
        pending: entry.pending === true, tracked: entry.tracked === true })
    }
    return prune(receipts)
  } catch { return [] }
}

export function recordBatchOutcome(receipts: OutcomeReceipt[], detail: BatchDetail) {
  const previous = prune(receipts).find(receipt => receipt.batchId === detail.id)
  const isCompletion = detail.status === 'COMPLETED' || detail.status === 'PARTIAL'
  // Timestamps, list order and display positions are management metadata.
  const outcome = isCompletion ? JSON.stringify([
    detail.status,
    [...detail.jobs].sort((a, b) => a.task_id.localeCompare(b.task_id))
      .map(job => [job.task_id, job.attempt, job.status]),
  ]) : null
  const outcomes = previous?.outcomes ?? []
  const notify = !!previous && outcome !== null && !outcomes.includes(outcome)
  const next = prune([
    ...receipts.filter(receipt => receipt.batchId !== detail.id),
    { batchId: detail.id, touchedAt: Date.now(),
      pending: !isTerminalBatch(detail.status),
      tracked: previous?.tracked === true || !isTerminalBatch(detail.status) || notify,
      outcomes: outcome && !outcomes.includes(outcome)
        ? [...outcomes, outcome].slice(-MAX_OUTCOMES) : outcomes },
  ])
  // Notification storage is optional; progress and history imports must proceed.
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, receipts: next })) }
  catch { /* Keep in-memory deduplication if storage is denied or full. */ }
  return { receipts: next, notify }
}
