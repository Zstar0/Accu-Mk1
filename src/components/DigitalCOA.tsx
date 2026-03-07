import { useState, useEffect, useRef } from 'react'
import { ShieldCheck } from 'lucide-react'

/**
 * Digital COA — embeds the AccuVerify badge web component from accumarklabs.com.
 * Lets the user enter a verification code and reload the badge.
 */
type BadgeTheme = 'dark' | 'light'
type BadgeSize = 'full' | 'md' | 'sm'

export function DigitalCOA() {
  const [code, setCode] = useState('ZENK-YJ3V')
  const [activeCode, setActiveCode] = useState('ZENK-YJ3V')
  const [theme, setTheme] = useState<BadgeTheme>('dark')
  const [size, setSize] = useState<BadgeSize>('full')
  const containerRef = useRef<HTMLDivElement>(null)
  const scriptLoaded = useRef(false)

  // Load the external embed script once
  useEffect(() => {
    if (scriptLoaded.current) return
    const existing = document.querySelector(
      'script[src*="accuverify-badge-embed"]'
    )
    if (existing) {
      scriptLoaded.current = true
      return
    }
    const script = document.createElement('script')
    script.type = 'module'
    script.src =
      'https://accumarklabs.com/wp-content/themes/wpstar/js/accuverify-badge-embed.js'
    script.onload = () => {
      scriptLoaded.current = true
    }
    document.head.appendChild(script)
  }, [])

  // Re-render the badge whenever activeCode, theme, or size changes
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.innerHTML = ''

    const badge = document.createElement('accuverify-badge')
    badge.setAttribute('code', activeCode)
    badge.setAttribute('theme', theme)
    badge.setAttribute('size', size)
    container.appendChild(badge)
  }, [activeCode, theme, size])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = code.trim()
    if (trimmed) {
      setActiveCode(trimmed)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-emerald-400" />
        <h1 className="text-xl font-semibold text-zinc-100">Digital COA</h1>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="verification-code"
            className="text-sm font-medium text-zinc-400"
          >
            Verification Code
          </label>
          <input
            id="verification-code"
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            className="h-9 w-56 rounded-md border border-zinc-700 bg-zinc-800 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-zinc-400">Theme</label>
          <div className="flex h-9 rounded-md border border-zinc-700 overflow-hidden">
            {(['dark', 'light'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTheme(t)}
                className={`px-3 text-sm capitalize transition-colors ${
                  theme === t
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-zinc-400">Size</label>
          <div className="flex h-9 rounded-md border border-zinc-700 overflow-hidden">
            {(['full', 'md', 'sm'] as const).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setSize(s)}
                className={`px-3 text-sm uppercase transition-colors ${
                  size === s
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <button
          type="submit"
          className="h-9 rounded-md bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-500 transition-colors"
        >
          Load COA
        </button>
      </form>

      <div
        ref={containerRef}
        className="min-h-[400px] rounded-lg border border-zinc-700 bg-zinc-900 p-4"
      />
    </div>
  )
}
