const API = '/api/api'
const token = new URLSearchParams(location.search).get('t')

const contextEl = document.getElementById('context')
const stationNameEl = document.getElementById('station-name')
const formEl = document.getElementById('scan-form')
const inputEl = document.getElementById('sample-input')
const statusEl = document.getElementById('status')
const logEl = document.getElementById('log')
const expiredEl = document.getElementById('expired')

let submitting = false

async function loadContext() {
  try {
    const r = await fetch(`${API}/bench/${encodeURIComponent(token)}`)
    if (r.status === 404) return showExpired()
    if (!r.ok)
      return showStatus(`Could not load (${r.status}) — pull to refresh`, 'error')
    const data = await r.json()
    stationNameEl.textContent = data.station_name
    focusInput()
  } catch (err) {
    showStatus(
      'Could not reach the server — check connection and pull to refresh',
      'error'
    )
  }
}

function focusInput() {
  // Scanner guns type into whatever has focus, then send Enter — keep the
  // input focused so both scanner-gun and manual entry land in the same
  // place without the operator having to tap first.
  inputEl.focus()
}

function showStatus(message, kind) {
  statusEl.classList.remove('status-success', 'status-error')
  if (kind === 'success') statusEl.classList.add('status-success')
  if (kind === 'error') statusEl.classList.add('status-error')
  statusEl.textContent = message
}

function showExpired() {
  contextEl.hidden = true
  expiredEl.hidden = false
}

function setSubmitting(v) {
  submitting = v
  inputEl.disabled = v
}

function logScan(sampleId, ok) {
  const li = document.createElement('li')
  const stamp = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  li.textContent = `${stamp} — ${sampleId} ${ok ? 'recorded' : 'failed'}`
  logEl.prepend(li)
  // Keep the visible log short — it's a rapid-scan confidence trail, not a record.
  while (logEl.children.length > 10) logEl.removeChild(logEl.lastChild)
}

async function submitScan(sampleId) {
  setSubmitting(true)
  showStatus('Recording…')
  let ok = false
  try {
    const r = await fetch(`${API}/bench/${encodeURIComponent(token)}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample_id: sampleId }),
    })
    if (r.status === 404) {
      const body = await r.json().catch(() => null)
      if (body && /bench token/i.test(body.detail || '')) return showExpired()
      showStatus(`Unknown vial: ${sampleId}`, 'error')
      return
    }
    if (!r.ok) {
      const body = await r.json().catch(() => null)
      showStatus((body && body.detail) || `Scan failed (${r.status})`, 'error')
      return
    }
    const data = await r.json()
    showStatus(`Scanned in — ${data.station_name}`, 'success')
    ok = true
    inputEl.value = ''
  } catch (err) {
    showStatus('Could not reach the server — try again', 'error')
  } finally {
    logScan(sampleId, ok)
    setSubmitting(false)
    focusInput()
    if (!ok) inputEl.select()
  }
}

formEl.addEventListener('submit', e => {
  e.preventDefault()
  if (submitting) return
  const sampleId = inputEl.value.trim()
  if (!sampleId) return
  submitScan(sampleId)
})

if (!token) {
  showExpired()
} else {
  loadContext()
}
