/**
 * Read-only embed shell for one pinned document revision (embed.html).
 *
 * Framed by an allowlisted host (Paperclip) via nginx `frame-ancestors`. Runs on
 * the Mk1 origin and uses Mk1's own login: the JWT never leaves this origin, is
 * never put in a URL and is never posted to the parent. Cross-site frames get
 * partitioned storage, so a top-level Mk1 login is not visible here; the
 * sign-in form below writes the token into the frame's own (partitioned) store.
 *
 * The reference rides in the URL hash (`#id=12&code=ART-0003&rev=2&sha=<hex>`),
 * non-secret and never sent to a server. The shell renders only when the row
 * Mk1 returns for `id` matches code, revision and content hash exactly; the
 * fetched bytes are hashed too. Mk1's document/space ACL is checked on every
 * fetch (hidden and missing both read as 404).
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getDocument,
  getDocumentContent,
  type DocumentDetail,
} from '@/lib/api-documents'
import { login } from '@/lib/auth-api'
import { useAuthStore } from '@/store/auth-store'
import { buildEmbedSrcDoc, parseEmbedRef, refMismatch } from './embed-utils'
import { DocumentProvenanceDetails } from './DocumentProvenance'

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text)
  )
  return Array.from(new Uint8Array(buf), b =>
    b.toString(16).padStart(2, '0')
  ).join('')
}

type State =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'auth' }
  | { kind: 'unavailable' }
  | { kind: 'mismatch' }
  | { kind: 'error' }
  | { kind: 'ready'; doc: DocumentDetail; html: string }

function statusOf(e: unknown): number | null {
  const m = /failed: (\d{3})$/.exec(e instanceof Error ? e.message : '')
  return m ? Number(m[1]) : null
}

export function DocumentEmbed({ hash }: { hash: string }) {
  const { t } = useTranslation()
  const token = useAuthStore(s => s.token)
  const [result, setResult] = useState<{ key: string; state: State } | null>(
    null
  )
  const dark =
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  const key = `${hash}|${token ?? ''}`

  useEffect(() => {
    const ref = parseEmbedRef(hash)
    if (!ref || !token) return
    const k = `${hash}|${token}`
    let live = true
    const done = (state: State) => live && setResult({ key: k, state })
    ;(async () => {
      try {
        const doc = await getDocument(ref.id)
        if (refMismatch(ref, doc)) return done({ kind: 'mismatch' })
        const html = await getDocumentContent(ref.id)
        if ((await sha256Hex(html)) !== ref.sha)
          return done({ kind: 'mismatch' })
        done({ kind: 'ready', doc, html })
      } catch (e) {
        const status = statusOf(e)
        if (status === 401) {
          if (live) useAuthStore.getState().clearAuth()
        } else if (status === 404 || status === 403)
          done({ kind: 'unavailable' })
        else done({ kind: 'error' })
      }
    })()
    return () => {
      live = false
    }
  }, [hash, token])

  const state: State = !parseEmbedRef(hash)
    ? { kind: 'invalid' }
    : !token
      ? { kind: 'auth' }
      : result?.key === key
        ? result.state
        : { kind: 'loading' }

  if (state.kind === 'auth') return <EmbedSignIn />
  if (state.kind !== 'ready') {
    return (
      <p
        className="p-4 text-sm text-muted-foreground"
        data-embed-state={state.kind}
      >
        {t(`documentEmbed.${state.kind}`)}
      </p>
    )
  }
  const { doc, html } = state
  const latest = doc.revisions.reduce(
    (n, r) => Math.max(n, r.revision),
    doc.revision
  )
  return (
    <div className="flex h-screen flex-col" data-embed-state="ready">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{doc.code}</span>
        <span>{t('documentEmbed.rev', { rev: doc.revision })}</span>
        <span
          data-embed-status={doc.status}
          className={`rounded border px-1.5 font-semibold uppercase ${
            doc.status === 'draft'
              ? 'border-amber-500 text-amber-700 dark:text-amber-400'
              : doc.status === 'retired'
                ? 'border-destructive text-destructive'
                : ''
          }`}
        >
          {doc.status}
        </span>
        {latest > doc.revision ? (
          <span>{t('documentEmbed.newer', { rev: latest })}</span>
        ) : null}
      </div>
      <DocumentProvenanceDetails doc={doc} />
      <iframe
        title={doc.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={buildEmbedSrcDoc(html, dark ? 'dark' : 'light')}
        className="w-full flex-1 border-0 bg-white"
      />
    </div>
  )
}

function EmbedSignIn() {
  const { t } = useTranslation()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setError(false)
    try {
      await login(String(f.get('email') ?? ''), String(f.get('password') ?? ''))
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      onSubmit={submit}
      className="mx-auto flex max-w-xs flex-col gap-2 p-4 text-sm"
      data-embed-state="auth"
    >
      <p>{t('documentEmbed.auth')}</p>
      <input
        name="email"
        type="email"
        autoComplete="username"
        required
        aria-label={t('documentEmbed.email')}
        placeholder={t('documentEmbed.email')}
        className="rounded border px-2 py-1"
      />
      <input
        name="password"
        type="password"
        autoComplete="current-password"
        required
        aria-label={t('documentEmbed.password')}
        placeholder={t('documentEmbed.password')}
        className="rounded border px-2 py-1"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded border px-2 py-1 font-medium"
      >
        {t('documentEmbed.signIn')}
      </button>
      {error ? (
        <p role="alert" className="text-destructive">
          {t('documentEmbed.signInFailed')}
        </p>
      ) : null}
    </form>
  )
}
