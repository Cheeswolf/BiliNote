import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
// IndexedDB is external to jsdom; retain its asynchronous key/value semantics.
vi.mock('idb-keyval', () => {
  const values = new Map<string, unknown>()
  return {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value)
    },
    del: async (key: string) => {
      values.delete(key)
    },
  }
})
afterEach(() => cleanup())
