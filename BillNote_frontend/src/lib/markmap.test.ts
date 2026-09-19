import { createElement, StrictMode } from 'react'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// These imports initialize browser animation/configuration APIs unrelated to asset loading.
vi.mock('lottie-react', () => ({ default: () => null }))
vi.mock('@lottiefiles/dotlottie-react', () => ({ DotLottieReact: () => null }))
vi.mock('@/services/model', () => ({ fetchEnableModels: vi.fn().mockResolvedValue([]) }))

let originalHead: Set<Element>
beforeEach(() => {
  vi.resetModules()
  originalHead = new Set(document.head.children)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network disabled in test')))
})
afterEach(() => {
  for (const element of document.head.children) {
    if (!originalHead.has(element)) element.remove()
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('imports MarkdownViewer and transforms markdown without loading mind-map assets', async () => {
  await import('@/pages/HomePage/components/MarkdownViewer')
  const { transformer } = await import('./markmap')
  transformer.transform('# Note\n\n$ x^2 $')

  expect(fetch).not.toHaveBeenCalled()
  expect(document.head.querySelector('link[href*="cdn.jsdelivr.net"], script[src*="cdn.jsdelivr.net"]')).toBeNull()
}, 30000)



it('initializes the existing styles and scripts once on explicit runtime initialization', async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response('/* offline CSS fixture */'))
  const { initializeMarkmapAssets } = await import('./markmap')
  const first = initializeMarkmapAssets()
  expect(initializeMarkmapAssets()).toBe(first)

  await vi.waitFor(() => expect(document.head.querySelector('script[src*="webfontloader"]')).not.toBeNull())
  document.head.querySelector('script[src*="webfontloader"]')!.dispatchEvent(new Event('load'))
  await expect(first).resolves.toBeUndefined()
  await initializeMarkmapAssets()

  expect(document.head.querySelectorAll('link[rel="stylesheet"][href*="katex"]')).toHaveLength(1)
  expect(document.head.querySelectorAll('link[rel="stylesheet"][href*="highlightjs"]')).toHaveLength(1)
  expect(document.head.querySelectorAll('script[src*="webfontloader"]')).toHaveLength(1)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('handles both stylesheet and script failures without rejected initialization promises', async () => {
  const { transformer, initializeMarkmapAssets } = await import('./markmap')
  // Unique URLs avoid the third-party loader's process-wide cache across tests.
  vi.spyOn(transformer, 'getAssets').mockReturnValue({
    styles: [{ type: 'stylesheet', data: { href: 'https://assets.invalid/failed.css' } }],
    scripts: [{ type: 'script', data: { src: 'https://assets.invalid/failed.js' } }],
  })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const initialization = initializeMarkmapAssets()
  await expect(initialization).resolves.toBeUndefined()
  document.head.querySelector('script[src="https://assets.invalid/failed.js"]')!.dispatchEvent(new Event('error'))
  // Give the later script rejection time to surface if it was left unhandled.
  await new Promise(resolve => setTimeout(resolve, 0))
  await expect(initializeMarkmapAssets()).resolves.toBeUndefined()
  expect(warning).toHaveBeenCalledTimes(1)
  expect(warning).toHaveBeenCalledWith('Unable to load mind-map assets', expect.any(Error))
  expect(document.head.querySelectorAll('script[src="https://assets.invalid/failed.js"]')).toHaveLength(1)
})

it('loads assets on mount and shares the load across concurrent and repeated mounts', async () => {
  vi.mocked(fetch).mockImplementation(async () => new Response('/* offline CSS fixture */'))
  const { transformer, initializeMarkmapAssets } = await import('./markmap')
  vi.spyOn(transformer, 'getAssets').mockReturnValue({
    styles: [{ type: 'stylesheet', data: { href: 'https://assets.invalid/mount.css' } }],
    scripts: [{ type: 'script', data: { src: 'https://assets.invalid/mount.js' } }],
  })
  // jsdom does not implement the SVG geometry used by d3. Keep the real
  // component, transformer, and network loaders; replace only SVG rendering.
  const { Markmap } = await import('markmap-view')
  vi.spyOn(Markmap, 'create').mockImplementation(() => {
    const instance = Object.create(Markmap.prototype) as InstanceType<typeof Markmap>
    instance.setData = vi.fn().mockResolvedValue(undefined)
    instance.fit = vi.fn().mockResolvedValue(undefined)
    return instance
  })
  const { default: MarkmapEditor } = await import('@/pages/HomePage/components/MarkmapComponent')
  const editor = createElement(StrictMode, null, createElement(MarkmapEditor, {
    value: '# Note', onChange: () => {},
  }))
  const first = render(editor)
  const second = render(editor)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledExactlyOnceWith('https://assets.invalid/mount.css'))
  const script = document.head.querySelector('script[src="https://assets.invalid/mount.js"]')!
  script.dispatchEvent(new Event('load'))
  await initializeMarkmapAssets()
  first.unmount()
  second.unmount()
  render(editor)
  await initializeMarkmapAssets()

  expect(document.head.querySelectorAll('link[href="https://assets.invalid/mount.css"]')).toHaveLength(1)
  expect(document.head.querySelectorAll('script[src="https://assets.invalid/mount.js"]')).toHaveLength(1)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('handles a script-only failure and does not repeat the cached failed load', async () => {
  const { transformer, initializeMarkmapAssets } = await import('./markmap')
  vi.spyOn(transformer, 'getAssets').mockReturnValue({
    scripts: [{ type: 'script', data: { src: 'https://assets.invalid/script-only-failure.js' } }],
  })
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const initialization = initializeMarkmapAssets()
  await vi.waitFor(() => expect(document.head.querySelector('script[src="https://assets.invalid/script-only-failure.js"]')).not.toBeNull())
  document.head.querySelector('script[src="https://assets.invalid/script-only-failure.js"]')!.dispatchEvent(new Event('error'))
  await expect(initialization).resolves.toBeUndefined()
  await initializeMarkmapAssets()

  expect(warning).toHaveBeenCalledTimes(1)
  expect(warning).toHaveBeenCalledWith('Unable to load mind-map assets', expect.any(Event))
  expect(document.head.querySelectorAll('script[src="https://assets.invalid/script-only-failure.js"]')).toHaveLength(1)
  expect(fetch).not.toHaveBeenCalled()
})
