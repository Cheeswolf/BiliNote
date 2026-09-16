// Detail reads, background reads and result imports share one asynchronous lane.
let inFlight: Promise<void> | null = null
const detailReaders = new Map<string, number>()
export const hasDetailReader = (id: string) => (detailReaders.get(id) ?? 0) > 0
export function registerDetailReader(id: string) {
  detailReaders.set(id, (detailReaders.get(id) ?? 0) + 1)
  return () => {
    const count = (detailReaders.get(id) ?? 1) - 1
    if (count) detailReaders.set(id, count)
    else detailReaders.delete(id)
  }
}
export async function inBatchPollingLane(run: () => Promise<void>) {
  while (inFlight) await inFlight
  // Keep the lane promise non-rejecting so a failed caller cannot poison waiters.
  const request = run()
  const settled = request.catch(() => {})
  inFlight = settled
  try { await request }
  finally { if (inFlight === settled) inFlight = null }
}
