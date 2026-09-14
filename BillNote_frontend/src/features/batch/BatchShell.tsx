import type { ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import logo from '@/assets/icon.svg'

export default function BatchShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b bg-white">
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
      <main className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">{children}</main>
    </div>
  )
}
