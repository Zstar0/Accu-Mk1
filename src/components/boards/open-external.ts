import { openUrl } from '@tauri-apps/plugin-opener'

/** Link nodes open OUTSIDE the app (spec §8.3, §9): never an iframe, never a javascript: URL. */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0
    )
  } catch {
    return false
  }
}

export function openExternal(url: string): void {
  if (!isSafeHttpUrl(url)) return
  // Tauri v2 marker; the desktop app grants `opener:default` (capabilities/default.json).
  if ('__TAURI_INTERNALS__' in window) {
    void openUrl(url)
    return
  }
  window.open(url, '_blank', 'noopener')
}
