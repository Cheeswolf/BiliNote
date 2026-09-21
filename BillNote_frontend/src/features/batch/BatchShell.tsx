import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import logo from '@/assets/icon.svg'

export default function BatchShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  // The fixed desktop health button occupies the bottom-right corner. At xl,
  // the centered max-w-6xl container already leaves enough room outside it.
  const actionPadding = isTauri ? 'pr-24 xl:pr-8' : 'pr-5 sm:pr-8'
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-neutral-50 text-neutral-900">
      <header className="shrink-0 border-b bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-6 px-5 py-4">
          <Link to="/" className="flex items-center gap-2 text-xl font-bold">
            <img src={logo} alt="" className="h-8 w-8" />BiliNote
          </Link>
          <nav aria-label="工作区" className="flex gap-2 text-sm">
            <NavLink to="/" end className="rounded-md px-3 py-2 hover:bg-neutral-100">单个视频</NavLink>
            <NavLink to="/batch" className="rounded-md bg-neutral-100 px-3 py-2 font-medium">批量任务</NavLink>
          </nav>
          <Link to="/settings" className="ml-auto text-sm text-neutral-500 hover:text-neutral-900">设置</Link>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-6 px-5 py-8 sm:px-8">{children}</div>
      </main>
      {actions && <footer aria-label="创建操作" className="shrink-0 border-t bg-white">
        <div className={`mx-auto flex w-full max-w-6xl flex-wrap items-center justify-end gap-3 py-3 pl-5 sm:pl-8 ${actionPadding}`}>{actions}</div>
      </footer>}
    </div>
  )
}
