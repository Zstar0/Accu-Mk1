# Terminal Output Pattern — SSE Scan Console

Reference implementation: the `scan-hplc` feature in Accu-Mk1. This document captures the design language, architecture, and implementation details so the pattern can be reused in other projects.

---

## Visual Design

### Overall Aesthetic

A faux terminal window embedded in the app UI — dark, monospaced, compact. Mimics a macOS terminal chrome but rendered entirely in HTML/CSS within a React component.

### Anatomy (top to bottom)

```
┌─────────────────────────────────────────────────────────┐
│ ● ● ●   $ accumark scan-hplc                        ✕  │  ← Title bar
├─────────────────────────────────────────────────────────┤
│ ████████████████████████░░░░░░░░░░                      │  ← Progress bar
│ 5/9 preps scanned                                       │  ← Progress label
├─────────────────────────────────────────────────────────┤
│ P-0121: no folder found                                 │  ← Log lines (scrollable)
│ PB-0059: found 'PB-0059_Sample_...', checking CSVs...  │
│ PB-0059: ✓ 3 PeakData, 4 chromatogram file(s)         │
│ ...                                                     │
├─────────────────────────────────────────────────────────┤
│ ✓ scan complete — 5 matches found                 100%  │  ← Footer / status bar
└─────────────────────────────────────────────────────────┘
```

### Traffic Light Dots (title bar, left)

Three 10px circles indicate phase state:

| Dot      | Idle        | Running                  | Done          | Error       |
| -------- | ----------- | ------------------------ | ------------- | ----------- |
| **Red**  | `zinc-700`  | `zinc-700`               | `zinc-700`    | `red-500`   |
| **Amber** | `zinc-700` | `amber-500/70` + pulse   | `zinc-700`    | `zinc-700`  |
| **Green** | `zinc-700` | `zinc-700`               | `emerald-500` | `zinc-700`  |

### Color System (log lines)

All text is `font-mono text-[11px]`. Colors are semantic by log level:

| Level     | Tailwind Class    | Hex Approx   | Usage                                     |
| --------- | ----------------- | ------------ | ----------------------------------------- |
| `info`    | `text-zinc-300`   | `#d4d4d8`    | Normal status messages                    |
| `dim`     | `text-zinc-600`   | `#52525b`    | Low-priority info, "no match" lines       |
| `warn`    | `text-amber-400`  | `#fbbf24`    | Warnings, partial matches                 |
| `success` | `text-emerald-400`| `#34d399`    | Matches found, scan complete              |
| `error`   | `text-red-400`    | `#f87171`    | Failures                                  |

### Progress Bar

- Container: `h-1 rounded-full bg-zinc-800`
- Fill: `h-full bg-emerald-500 transition-all duration-300`
- Width is `(current / total) * 100%`
- Label below: `text-zinc-600 font-mono text-[10px]` — e.g. `5/9 preps scanned`

### Footer / Status Bar

- Background: `bg-[#0a0a0a]` with `border-t border-zinc-900`
- Font: `font-mono text-[10px]`
- States:
  - Running: `text-amber-400/50` — `scanning·····`
  - Done: `text-emerald-500/70` — `✓ scan complete — N match(es) found`
  - Error: `text-red-400/70` — `✗ scan failed`
- Right-aligned percentage when progress is active

### Animated Dots (loading indicator)

Cycles through 5 frames at 280ms intervals: `·`, `··`, `···`, `····`, `·····`

Used in both the empty-state placeholder (`Initialising·····`) and the footer (`scanning·····`).

### Container Styling

```
rounded-lg overflow-hidden
border border-zinc-800/80
shadow-2xl shadow-black/90
select-none
```

Log area: `bg-[#0d0d0d]`, max height `max-h-52`, auto-scroll to bottom.

---

## Architecture

### Three-Layer SSE Pipeline

```
Backend (Python/FastAPI)          Frontend Client (api.ts)         UI Component (React)
─────────────────────────         ───────────────────────         ────────────────────
SSE Generator                     Fetch + ReadableStream          State + Render
  yield ev("log", {...})    →       parse SSE frames        →      setScanLogs([...prev, line])
  yield ev("progress", {}) →       route by event type      →      setScanProgress({cur, tot})
  yield ev("match", {})    →       call typed callbacks     →      setScanMatches(map)
  yield ev("done", {})     →       signal completion        →      setScanPhase('done')
  yield ev("error", {})    →       signal error             →      setScanPhase('error')
```

### SSE Event Types

| Event      | Payload Shape                                   | Purpose                     |
| ---------- | ----------------------------------------------- | --------------------------- |
| `log`      | `{ msg: string, level: LogLevel }`              | Append a line to the console |
| `progress` | `{ current: number, total: number }`            | Update the progress bar      |
| `match`    | `{ prep_id, folder_name, peak_files, ... }`     | Signal a successful match    |
| `done`     | `{ matches: Match[] }`                          | Stream complete              |
| `error`    | `{ msg: string }`                               | Fatal error, stream ends     |

### Backend (FastAPI SSE Generator)

```python
@app.get("/sample-preps/scan-hplc")
async def scan_sample_preps_hplc():
    async def _generate():
        def ev(etype: str, data: dict) -> str:
            return f"event: {etype}\ndata: {json.dumps(data)}\n\n"

        yield ev("log", {"msg": "Starting...", "level": "info"})
        yield ev("progress", {"current": 0, "total": total})

        for i, item in enumerate(items):
            yield ev("progress", {"current": i + 1, "total": total})
            # ... scan logic ...
            yield ev("log", {"msg": f"{item}: ✓ found", "level": "success"})
            yield ev("match", {... match data ...})

        yield ev("done", {"matches": matches})

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
```

Key details:
- Each SSE frame is `event: <type>\ndata: <json>\n\n`
- The `X-Accel-Buffering: no` header prevents nginx/reverse-proxy buffering
- Generator yields strings, not bytes — FastAPI handles encoding

### Frontend SSE Client

```typescript
export function scanSamplePrepsHplc(opts: {
  onLog: (line: LogLine) => void
  onMatch: (match: Match) => void
  onProgress: (current: number, total: number) => void
  onDone: (matches: Match[]) => void
  onError: (msg: string) => void
}): () => void {
  const abortController = new AbortController()

  ;(async () => {
    const response = await fetch(url, {
      headers: authHeaders,
      signal: abortController.signal,
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Split on double-newline (SSE frame boundary)
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        // Parse event type and data from SSE frame
        let eventType = 'message', dataStr = ''
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim()
          else if (line.startsWith('data: ')) dataStr = line.slice(6).trim()
        }
        const data = JSON.parse(dataStr)
        // Route to callback by event type
      }
    }
  })()

  return () => abortController.abort()  // cancel function
}
```

Key details:
- Uses `fetch` + `ReadableStream` (not `EventSource`) for auth header support
- Returns a cancel function via `AbortController`
- Buffers partial chunks and splits on `\n\n` boundaries
- Silently ignores malformed SSE frames

### React Component State

```typescript
type ScanPhase = 'idle' | 'running' | 'done' | 'error'

// Core state
const [scanPhase, setScanPhase] = useState<ScanPhase>('idle')
const [scanLogs, setScanLogs] = useState<LogLine[]>([])
const [scanProgress, setScanProgress] = useState<{ current: number; total: number } | null>(null)
const [scanMatches, setScanMatches] = useState<Map<number, Match>>(new Map())
const [showConsole, setShowConsole] = useState(false)
const cancelScanRef = useRef<(() => void) | null>(null)
```

- Logs accumulate via `setScanLogs(prev => [...prev, line])`
- Matches stored in a `Map` keyed by entity ID for O(1) lookup
- Cancel ref allows aborting mid-stream
- Console auto-scrolls via `useEffect` watching `logs` and setting `scrollTop = scrollHeight`

---

## Reuse Checklist

To adapt this pattern for a new scan/operation:

1. **Define your event types** — at minimum: `log`, `progress`, `done`, `error`. Add domain-specific events as needed (like `match`).
2. **Define your log levels** — `info`, `dim`, `warn`, `success`, `error` covers most cases. Map each to a color.
3. **Backend**: Write an async generator that yields SSE frames. Use the `ev()` helper pattern.
4. **Client**: Copy the fetch+ReadableStream SSE parser. Swap out the callback interface for your event types.
5. **Component**: The `ScanConsole` component is self-contained — extract it, parameterize the title bar text and event handlers.

### What Makes It Feel Good

- **Real-time streaming** — not a spinner-then-dump. Users see progress as it happens.
- **Semantic color coding** — you can glance at the console and immediately see red/amber/green status without reading text.
- **Compact typography** — 11px mono for logs, 10px for chrome. Dense but readable.
- **Dark-on-dark contrast** — `#0d0d0d` body, `zinc-900` title bar, `#0a0a0a` footer. Three subtle shades of near-black create depth.
- **Animated dots** — the only animation besides the progress bar. Subtle proof of liveness without being distracting.
- **Closeable but not dismissive** — close button only appears when the scan isn't running. Prevents accidental dismissal.
- **No modal overlay** — the console is inline, not blocking. Users can still see and interact with the rest of the page.
