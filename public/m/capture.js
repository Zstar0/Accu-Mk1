const API = '/api/api'
const token = new URLSearchParams(location.search).get('t')

const contextEl = document.getElementById('context')
const orderLabelEl = document.getElementById('order-label')
const sampleListEl = document.getElementById('sample-list')
const expiryNoteEl = document.getElementById('expiry-note')
const shootEl = document.getElementById('shoot')
const captureLabelEl = document.getElementById('captureLabel')
const cameraInputEl = document.getElementById('camera')
const statusEl = document.getElementById('status')
const thumbsEl = document.getElementById('thumbs')
const expiredEl = document.getElementById('expired')

let count = 0
let uploading = false
let pending = null // { dataUrl, thumbEl } awaiting a manual retry

async function loadContext() {
  try {
    const r = await fetch(`${API}/capture/${encodeURIComponent(token)}`)
    if (r.status === 404 || r.status === 410) return showExpired()
    if (!r.ok)
      return showStatus(`Could not load (${r.status}) — pull to refresh`, true)
    renderContext(await r.json())
  } catch (err) {
    showStatus(
      'Could not reach the server — check connection and pull to refresh',
      true
    )
  }
}

function renderContext(data) {
  const samples = Array.isArray(data.samples) ? data.samples : []
  count = data.photo_count || 0

  orderLabelEl.textContent = data.order_label
    ? `Order ${data.order_label}`
    : samples.length === 1
      ? `Sample ${samples[0].sample_id}`
      : `${samples.length} samples`

  sampleListEl.innerHTML = ''
  for (const s of samples) {
    const li = document.createElement('li')
    li.className = 'sample-row'

    const id = document.createElement('span')
    id.className = 'sample-id'
    id.textContent = s.sample_id
    li.appendChild(id)

    if (s.lot) {
      const lot = document.createElement('span')
      lot.className = 'sample-lot'
      lot.textContent = `Lot ${s.lot}`
      li.appendChild(lot)
    }

    const analytesText = Array.isArray(s.analytes)
      ? s.analytes.join(', ')
      : s.analytes || ''
    if (analytesText) {
      const analytes = document.createElement('span')
      analytes.className = 'sample-analytes'
      analytes.textContent = analytesText
      li.appendChild(analytes)
    }

    sampleListEl.appendChild(li)
  }

  const expires = parseUtc(data.expires_at)
  expiryNoteEl.textContent = expires
    ? `Expires ${expires.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : ''

  showStatus(photoCountLabel(count))
}

// Backend datetimes are naive UTC (no trailing Z/offset) — force UTC
// interpretation so the phone's local-time render isn't off by the
// device's UTC offset.
function parseUtc(s) {
  if (!s) return null
  const iso = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

function photoCountLabel(n) {
  return n > 0
    ? `Saved — ${n} photo${n === 1 ? '' : 's'} this session`
    : 'No photos yet this session'
}

function showStatus(message, isError = false, showRetry = false) {
  statusEl.classList.toggle('status-error', isError)
  statusEl.textContent = ''

  const span = document.createElement('span')
  span.textContent = message
  statusEl.appendChild(span)

  if (showRetry) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'retry-btn'
    btn.textContent = 'Retry'
    btn.addEventListener('click', retryUpload)
    statusEl.appendChild(btn)
  }
}

function showExpired() {
  contextEl.hidden = true
  shootEl.hidden = true
  expiredEl.hidden = false
}

function setUploading(v) {
  uploading = v
  cameraInputEl.disabled = v
  captureLabelEl.classList.toggle('is-busy', v)
}

function addThumb(file) {
  const wrap = document.createElement('div')
  wrap.className = 'thumb thumb-pending'

  const img = document.createElement('img')
  const objectUrl = URL.createObjectURL(file)
  img.src = objectUrl
  img.onload = () => URL.revokeObjectURL(objectUrl)
  wrap.appendChild(img)

  const badge = document.createElement('span')
  badge.className = 'thumb-badge'
  badge.textContent = '…'
  wrap.appendChild(badge)

  thumbsEl.prepend(wrap)
  return wrap
}

function markThumbDone(wrap) {
  wrap.classList.remove('thumb-pending')
  wrap.classList.add('thumb-done')
}

function markThumbFailed(wrap) {
  wrap.classList.remove('thumb-pending')
  wrap.classList.add('thumb-failed')
  const badge = wrap.querySelector('.thumb-badge')
  if (badge) badge.textContent = '!'
}

// Downscale to max edge 2000px, re-encode JPEG q0.85 (normalizes HEIC,
// caps upload size), return base64 (as a data: URL — the backend accepts
// the same shape via photo_base64).
async function encodeShot(file) {
  const bmp = await loadBitmap(file)
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bmp.width * scale))
  canvas.height = Math.max(1, Math.round(bmp.height * scale))
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
  if (typeof bmp.close === 'function') bmp.close()
  return canvas.toDataURL('image/jpeg', 0.85)
}

async function loadBitmap(file) {
  try {
    return await createImageBitmap(file)
  } catch (err) {
    // iOS Safari < 17 lacks createImageBitmap(File) support in some paths —
    // fall back to FileReader + <img> decode into the same canvas path.
    return await loadImageViaFileReader(file)
  }
}

function loadImageViaFileReader(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('decode failed'))
      img.onload = () => resolve(img)
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

async function upload(dataUrl) {
  const r = await fetch(`${API}/capture/${encodeURIComponent(token)}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo_base64: dataUrl }),
  })
  if (r.status === 404 || r.status === 410) return showExpired()
  if (!r.ok) {
    const err = new Error(`upload failed (${r.status})`)
    err.status = r.status
    throw err
  }
  return r.json()
}

async function attemptUpload(dataUrl, thumbEl) {
  try {
    const result = await upload(dataUrl)
    if (!result) return // showExpired() already took over the page
    markThumbDone(thumbEl)
    count = result.photo_count
    showStatus(photoCountLabel(count))
  } catch (err) {
    markThumbFailed(thumbEl)
    if (err.status === 429) {
      showStatus(
        'Photo limit reached for this session (50) — reopen the packaging tab on desktop for a new QR',
        true
      )
    } else if (err.status === 413) {
      showStatus('Photo too large — try again', true)
    } else if (err.status === 415) {
      showStatus('Unsupported photo format', true)
    } else {
      pending = { dataUrl, thumbEl }
      showStatus('Upload failed', true, true)
    }
  } finally {
    setUploading(false)
  }
}

async function retryUpload() {
  if (!pending || uploading) return
  const { dataUrl, thumbEl } = pending
  pending = null
  setUploading(true)
  showStatus('Retrying…')
  await attemptUpload(dataUrl, thumbEl)
}

cameraInputEl.addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!file || uploading) return

  setUploading(true)
  const thumbEl = addThumb(file)
  showStatus('Uploading…')

  let dataUrl
  try {
    dataUrl = await encodeShot(file)
  } catch (err) {
    thumbEl.remove()
    showStatus('Could not read that photo — try again', true)
    setUploading(false)
    return
  }

  await attemptUpload(dataUrl, thumbEl)
})

if (!token) {
  showExpired()
} else {
  loadContext()
}
