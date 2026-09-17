import { create, type StateCreator } from 'zustand'
import { TaskStorageError } from '@/utils/polling'
import { persist, createJSONStorage } from 'zustand/middleware'
import { delete_task, generateNote } from '@/services/note.ts'
import { v4 as uuidv4 } from 'uuid'
import toast from 'react-hot-toast'
import { get, set, del } from 'idb-keyval'

export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PARSING'
  | 'DOWNLOADING'
  | 'TRANSCRIBING'
  | 'SUMMARIZING'
  | 'FORMATTING'
  | 'SAVING'
  | 'SUCCESS'
  | 'FAILED'
  | 'INTERRUPTED'
  | 'CANCELLED'
export type TaskConnection = 'online' | 'offline' | 'reconnecting'

export interface AudioMeta {
  cover_url: string
  duration: number
  file_path: string
  platform: string
  raw_info: { uploader?: string; webpage_url?: string; [key: string]: unknown } | null
  title: string
  video_id: string
}

export interface Segment {
  start: number
  end: number
  text: string
}

export interface Transcript {
  full_text: string
  language: string
  raw: unknown
  segments: Segment[]
}
export interface Markdown {
  ver_id: string
  content: string
  style: string
  model_name: string
  created_at: string
}

export interface Task {
  id: string
  markdown: string | Markdown[] //为了兼容之前的笔记
  // Optional for legacy history; explicitly selects imports and subsequent edits.
  currentMarkdownVersionId?: string
  transcript: Transcript
  status: TaskStatus
  audioMeta: AudioMeta
  createdAt: string
  platform?: string
  formData: {
    video_url: string
    link?: boolean
    screenshot?: boolean
    platform: string
    quality: string
    model_name: string
    provider_id: string
    style?: string
    format?: string[]
    grid_size?: number[]
    extras?: string
    video_understand?: boolean
    video_interval?: number
  }
}

interface TaskStore {
  tasks: Task[]
  // Durable acknowledgements survive removeTask/clearTasks. Attempts increase on retry.
  batchImportedAttempts: Record<string, number>
  currentTaskId: string | null
  storageError: string | null
  connections: Record<string, TaskConnection>
  setTaskConnection: (id: string, connection: TaskConnection) => void
  importCompletedTask: (task: Task, batchAttempt: number) => Promise<void>
  addPendingTask: (taskId: string, platform: string, formData?: Task['formData']) => void
  updateTaskContent: (id: string, data: Partial<Omit<Task, 'id' | 'createdAt'>>) => void
  removeTask: (id: string) => void
  clearTasks: () => void
  setCurrentTask: (taskId: string | null) => void
  getCurrentTask: () => Task | null
  retryTask: (id: string, payload?: Task['formData']) => Promise<void>
}

// Persistence is untrusted. Invalid entries must not hide successful results.
const hydrateBatchImportedAttempts = (value: unknown): Record<string, number> => {
  if (value === null || typeof value !== 'object' ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return {}
  return Object.fromEntries(Object.entries(value).filter(([taskId, attempt]) =>
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(taskId) &&
    typeof attempt === 'number' && Number.isSafeInteger(attempt) && attempt >= 0))
}

// Keep historical objects intact, promote matching content, and allocate fresh
// IDs for colliding results. Selection is explicit, independent of timestamps.
const mergeImportedTask = (existing: Task | undefined, incoming: Task): Task => {
  const versions = (task: Task): Markdown[] => typeof task.markdown === 'string'
    ? task.markdown ? [{
        ver_id: `${task.id}-legacy`, content: task.markdown,
        style: task.formData?.style || '', model_name: task.formData?.model_name || '',
        created_at: task.createdAt,
      }] : []
    : task.markdown
  const previous = existing ? versions(existing) : []
  const occupiedIds = new Set(previous.map(version => version.ver_id))
  const uniqueVersion = (version: Markdown): Markdown => {
    let id = version.ver_id
    let suffix = 1
    while (occupiedIds.has(id)) id = `${version.ver_id}-${suffix++}`
    occupiedIds.add(id)
    return id === version.ver_id ? version : { ...version, ver_id: id }
  }
  const imported: Markdown[] = []
  const importedContents = new Set<string>()
  const promoted = new Set<Markdown>()
  for (const version of versions(incoming)) {
    if (importedContents.has(version.content)) continue
    importedContents.add(version.content)
    const matching = previous.find(old => old.content === version.content)
    if (matching) {
      imported.push(matching)
      promoted.add(matching)
    } else {
      imported.push(uniqueVersion(version))
    }
  }
  return {
    ...existing,
    ...incoming,
    createdAt: existing?.createdAt ?? incoming.createdAt,
    currentMarkdownVersionId: imported[0]?.ver_id,
    markdown: [...imported, ...previous.filter(version => !promoted.has(version))],
    // Batch summaries supply the canonical source, but omit generation settings.
    formData: {
      ...incoming.formData,
      ...existing?.formData,
      video_url: incoming.formData.video_url,
      platform: incoming.formData.platform,
    },
  }
}

type PersistedTaskState = Pick<TaskStore, 'tasks' | 'currentTaskId' | 'batchImportedAttempts'>
const createTaskStore: StateCreator<TaskStore, [], [['zustand/persist', PersistedTaskState]]> = (
  setTransient,
  getState,
  api
) =>
  persist<TaskStore, [], [], PersistedTaskState>(
    (persistSet, get) => {
      const set = (update: Partial<TaskStore> | ((state: TaskStore) => Partial<TaskStore>)) => {
        assertTaskHistoryHydrated()
        const current = get()
        const next = typeof update === 'function' ? update(current) : update
        if (
          Object.keys(next).every(key =>
            Object.is(current[key as keyof TaskStore], next[key as keyof TaskStore])
          )
        )
          return
        return persistSet(next)
      }
      return {
        tasks: [],
        batchImportedAttempts: {},
        currentTaskId: null,
        connections: {},
        storageError: null,
        setTaskConnection: (id, connection) => {
          if (get().connections[id] === connection) return
          // Use the original Zustand setter: transient state must not call persist.setItem.
          setTransient(state => ({ connections: { ...state.connections, [id]: connection } }))
        },
        importCompletedTask: async (task, batchAttempt) => {
          const previousAttempt = get().batchImportedAttempts[task.id]
          if (previousAttempt >= batchAttempt) return
          try {
            // One persisted snapshot commits the note and its acknowledgement together.
            await set(state => {
              const existing = state.tasks.find(t => t.id === task.id)
              return {
                tasks: existing
                  ? state.tasks.map(t => t.id === task.id ? mergeImportedTask(t, task) : t)
                  : [mergeImportedTask(undefined, task), ...state.tasks],
                batchImportedAttempts: { ...state.batchImportedAttempts, [task.id]: batchAttempt },
              }
            })
          } catch (error) {
            // A failed write is still owed. Keep the in-memory note but retry its commit.
            const attempts = { ...get().batchImportedAttempts }
            if (previousAttempt === undefined) delete attempts[task.id]
            else attempts[task.id] = previousAttempt
            setTransient({ batchImportedAttempts: attempts })
            throw new TaskStorageError('Task history storage unavailable: ' +
              (error instanceof Error ? error.message : String(error)))
          }
        },

        addPendingTask: (
          taskId,
          platform,
          formData = { video_url: '', platform, quality: '', model_name: '', provider_id: '' }
        ) =>
          set(state => ({
            tasks: [
              {
                formData: formData,
                id: taskId,
                status: 'PENDING',
                markdown: '',
                platform: platform,
                transcript: {
                  full_text: '',
                  language: '',
                  raw: null,
                  segments: [],
                },
                createdAt: new Date().toISOString(),
                audioMeta: {
                  cover_url: '',
                  duration: 0,
                  file_path: '',
                  platform: '',
                  raw_info: null,
                  title: '',
                  video_id: '',
                },
              },
              ...state.tasks,
            ],
            currentTaskId: taskId, // 默认设置为当前任务
          })),

        updateTaskContent: (id, data) => {
          const task = get().tasks.find(task => task.id === id)
          if (
            !task ||
            Object.entries(data).every(([key, value]) => Object.is(task[key as keyof Task], value))
          )
            return
          set(state => ({
            tasks: state.tasks.map(task => {
              if (task.id !== id) return task

              if (task.status === 'SUCCESS' && data.status === 'SUCCESS') return task

              // 如果是 markdown 字符串，封装为版本
              if (typeof data.markdown === 'string') {
                const prev = task.markdown
                const newVersion: Markdown = {
                  ver_id: `${task.id}-${uuidv4()}`,
                  content: data.markdown,
                  style: task.formData.style || '',
                  model_name: task.formData.model_name || '',
                  created_at: new Date().toISOString(),
                }

                let updatedMarkdown: Markdown[]
                if (Array.isArray(prev)) {
                  updatedMarkdown = [newVersion, ...prev]
                } else {
                  updatedMarkdown = [
                    newVersion,
                    ...(typeof prev === 'string' && prev
                      ? [
                          {
                            ver_id: `${task.id}-${uuidv4()}`,
                            content: prev,
                            style: task.formData.style || '',
                            model_name: task.formData.model_name || '',
                            created_at: new Date().toISOString(),
                          },
                        ]
                      : []),
                  ]
                }

                return {
                  ...task,
                  ...data,
                  markdown: updatedMarkdown,
                  currentMarkdownVersionId: newVersion.ver_id,
                }
              }

              return { ...task, ...data }
            }),
          }))
        },

        getCurrentTask: () => {
          const currentTaskId = get().currentTaskId
          return get().tasks.find(task => task.id === currentTaskId) || null
        },
        retryTask: async (id, payload) => {
          if (!id) {
            toast.error('任务不存在')
            return
          }
          const task = get().tasks.find(task => task.id === id)
          console.log('retry', task)
          if (!task) return

          const newFormData = payload || task.formData
          try {
            await generateNote({
              ...newFormData,
              style: newFormData.style ?? '',
              format: newFormData.format ?? [],
              grid_size: newFormData.grid_size ?? [],
              task_id: id,
            })
          } catch (e: unknown) {
            const error = e as { data?: { reason?: string; downloading?: boolean } }
            // 就绪门禁：转写模型未下载好。不要把任务标成 PENDING（会一直转），
            // 给提示让用户先去下载。
            if (error?.data?.reason === 'transcriber_model_not_ready') {
              toast.error(
                error?.data?.downloading
                  ? '转写模型正在下载中，请稍候再重试'
                  : '转写模型尚未下载，请先去「设置 → 音频转写配置」页下载'
              )
              return
            }
            console.error('重试任务失败：', e)
            return
          }

          set(state => ({
            tasks: state.tasks.map(t =>
              t.id === id
                ? {
                    ...t,
                    formData: newFormData, // ✅ 显式更新 formData
                    status: 'PENDING',
                  }
                : t
            ),
          }))
        },

        removeTask: async id => {
          const task = get().tasks.find(t => t.id === id)

          // 更新 Zustand 状态
          set(state => ({
            tasks: state.tasks.filter(task => task.id !== id),
            currentTaskId: state.currentTaskId === id ? null : state.currentTaskId,
          }))

          // 调用后端删除接口（如果找到了任务）
          if (task) {
            await delete_task({
              video_id: task.audioMeta.video_id,
              platform: task.platform || task.audioMeta.platform || task.formData.platform,
            })
          }
        },

        clearTasks: () => set({ tasks: [], currentTaskId: null }),

        setCurrentTask: taskId => set({ currentTaskId: taskId }),
      }
    },
    {
      name: 'task-storage',
      onRehydrateStorage: () => (_state, error) => {
        setTransient({
          storageError: error
            ? 'Task history storage unavailable: ' +
              (error instanceof Error ? error.message : String(error))
            : null,
        })
      },
      // Preserve the existing version/key and note shapes; validate import metadata on hydration.
      merge: (persisted, current) => {
        const saved = persisted as Partial<TaskStore> | undefined
        return {
          ...current,
          ...saved,
          connections: {},
          batchImportedAttempts: hydrateBatchImportedAttempts(saved?.batchImportedAttempts),
          tasks: (saved?.tasks ?? current.tasks).map(task => ({
            ...task,
            status: (task.status as string) === 'FAILD' ? 'FAILED' : task.status,
          })),
        }
      },
      partialize: state => ({ tasks: state.tasks, currentTaskId: state.currentTaskId,
        batchImportedAttempts: state.batchImportedAttempts }),
      storage: createJSONStorage(() => ({
        getItem: async (name: string): Promise<string | null> => {
          const value = await get(name)
          return value ?? null
        },
        setItem: async (name: string, value: string): Promise<void> => {
          await set(name, value)
        },
        removeItem: async (name: string): Promise<void> => {
          await del(name)
        },
      })),
    }
  )(setTransient, getState, api)

export const useTaskStore = create<TaskStore>()(createTaskStore)

const assertTaskHistoryHydrated = () => {
  if (!useTaskStore.persist.hasHydrated()) {
    throw new TaskStorageError(
      useTaskStore.getState().storageError || 'Task history storage has not finished loading'
    )
  }
}
let hydration: Promise<void> | undefined
export const ensureTaskHistoryHydrated = async () => {
  if (useTaskStore.persist.hasHydrated()) return
  hydration ??= Promise.resolve(useTaskStore.persist.rehydrate()).finally(() => {
    hydration = undefined
  })
  await hydration
  // Zustand resolves even when its storage read failed. Only this flag confirms success.
  assertTaskHistoryHydrated()
}
