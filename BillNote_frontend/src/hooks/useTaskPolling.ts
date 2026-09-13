import { useEffect, useRef } from 'react'
import { isLegacyTaskFailure, isPollingNetworkError } from '@/utils/polling'
import { useTaskStore } from '@/store/taskStore'
import { get_task_status } from '@/services/note'
import toast from 'react-hot-toast'

export const useTaskPolling = (interval = 3000) => {
  const inFlight = useRef(false)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let failures = 0
    const poll = async () => {
      if (inFlight.current) {
        timer = setTimeout(() => {
          void poll()
        }, interval)
        return
      }
      inFlight.current = true
      let disconnected = false
      try {
        const pending = useTaskStore
          .getState()
          .tasks.filter(
            task => !['SUCCESS', 'FAILED', 'INTERRUPTED', 'CANCELLED'].includes(task.status)
          )
        for (const task of pending) {
          if (cancelled) break
          const store = useTaskStore.getState()
          if (store.connections[task.id] === 'offline')
            store.setTaskConnection(task.id, 'reconnecting')
          try {
            const res = await get_task_status(task.id, { suppressToast: true })
            if (cancelled) break
            store.setTaskConnection(task.id, 'online')
            if (res.status === 'SUCCESS' && res.result) {
              const { markdown, transcript, audio_meta } = res.result
              store.updateTaskContent(task.id, {
                status: res.status,
                markdown,
                transcript,
                audioMeta: { ...audio_meta, cover_url: audio_meta.cover_url ?? '' },
              })
              toast.success('笔记生成成功')
            } else if (res.status !== 'SUCCESS' && res.status !== task.status) {
              store.updateTaskContent(task.id, { status: res.status })
            }
          } catch (error) {
            if (cancelled) break
            if (isLegacyTaskFailure(error)) store.updateTaskContent(task.id, { status: 'FAILED' })
            const offline = isPollingNetworkError(error)
            disconnected ||= offline
            store.setTaskConnection(task.id, offline ? 'offline' : 'online')
          }
        }
      } finally {
        inFlight.current = false
        failures = disconnected ? failures + 1 : 0
        if (!cancelled)
          timer = setTimeout(
            () => {
              void poll()
            },
            Math.min(interval * 2 ** Math.min(failures, 10), 30000)
          )
      }
    }
    timer = setTimeout(() => {
      void poll()
    }, interval)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [interval])
}
