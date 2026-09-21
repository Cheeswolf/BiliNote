import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import logo from '@/assets/icon.svg'

export default function BatchShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
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
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-end gap-3 px-5 py-3 sm:px-8">{actions}</div>
      </footer>}
    </div>
  )
}
