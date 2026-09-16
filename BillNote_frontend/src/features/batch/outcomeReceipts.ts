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
  importPending: boolean
}
// Never expire or cap work still owed to the user. Only terminal history is bounded.
const prune = (receipts: OutcomeReceipt[]) => [
  ...receipts.filter(receipt => receipt.pending || receipt.importPending),
  ...receipts.filter(receipt => !receipt.pending && !receipt.importPending &&
    receipt.touchedAt >= Date.now() - MAX_AGE).slice(-MAX_BATCHES),
]
const save = (receipts: OutcomeReceipt[]) => {
  const next = prune(receipts)
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, receipts: next })) }
  catch { /* Keep in-memory deduplication if storage is denied or full. */ }
  return next
}

export function trackSubmittedBatch(receipts: OutcomeReceipt[], batchId: string) {
  const previous = receipts.find(receipt => receipt.batchId === batchId)
  return save([
    ...receipts.filter(receipt => receipt.batchId !== batchId),
    { batchId, touchedAt: Date.now(), pending: true, tracked: true,
      importPending: previous?.importPending ?? false,
      // Discovery may have silently baselined this batch before submit returned.
      outcomes: previous?.tracked ? previous.outcomes : [] },
  ])
}

export function acknowledgeBatchImports(receipts: OutcomeReceipt[], batchId: string) {
  return save(receipts.map(receipt => receipt.batchId === batchId
    ? { ...receipt, importPending: false } : receipt))
}

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
        pending: entry.pending === true, tracked: entry.tracked === true,
        // Older tracked terminal receipts may still owe an import; inspect once.
        importPending: entry.importPending === true ||
          (entry.importPending === undefined && entry.tracked === true && entry.pending !== true) })
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
  const tracked = previous?.tracked === true || !isTerminalBatch(detail.status) || notify
  const next = save([
    ...receipts.filter(receipt => receipt.batchId !== detail.id),
    { batchId: detail.id, touchedAt: Date.now(),
      pending: !isTerminalBatch(detail.status),
      tracked,
      importPending: previous?.importPending === true ||
        (tracked && detail.jobs.some(job => job.status === 'SUCCESS')),
      outcomes: outcome && !outcomes.includes(outcome)
        ? [...outcomes, outcome].slice(-MAX_OUTCOMES) : outcomes },
  ])
  return { receipts: next, notify }
}
