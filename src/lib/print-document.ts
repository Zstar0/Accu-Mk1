/**
 * Print a standalone HTML document from inside the app without touching the
 * app's own print CSS.
 *
 * PrintStep.css sets @page to the 50.8mm x 6.35mm label media for every print
 * of the main document, so a landscape bench sheet cannot print from there.
 * The document goes into an isolated off-screen iframe (its own stylesheet,
 * its own @page rules) and that frame is what prints. Works in the browser
 * build and in the Tauri WebView; the frame is removed after printing, or
 * after a long timeout where afterprint never fires.
 */
export function printHtmlDocument(html: string): void {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('title', 'print')
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    frame.remove()
  }
  frame.addEventListener('load', () => {
    const win = frame.contentWindow
    if (!win) {
      cleanup()
      return
    }
    win.addEventListener('afterprint', () => setTimeout(cleanup, 0), {
      once: true,
    })
    // Give fonts a tick to lay out before the dialog opens.
    setTimeout(() => {
      win.focus()
      win.print()
    }, 150)
    // afterprint is unreliable in some WebViews; never leak the frame.
    setTimeout(cleanup, 120_000)
  })
  frame.srcdoc = html
  document.body.appendChild(frame)
}

/** Hand the user a file to save (used for the CSV export). */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'text/csv;charset=utf-8'
): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
