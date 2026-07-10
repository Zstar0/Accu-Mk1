/**
 * Renders one comment body: markdown-lite HTML (via renderCommentHtml) set with
 * dangerouslySetInnerHTML, then an effect resolves each attachment token's
 * <img> to a bearer-authed blob object URL (module-pure: the backend serves
 * bytes, not public URLs). Clicking an attachment image opens a lightbox.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  renderCommentHtml,
  type MentionToken,
} from '@/components/flags/comment-markdown'
import { nameForUser, type UserMap } from '@/components/flags/flag-users'
import { fetchFlagAttachmentUrl } from '@/lib/flags-api'

export function CommentBody({
  body,
  mentions,
  users,
}: {
  body: string
  mentions: number[]
  users: UserMap
}) {
  const html = useMemo(() => {
    const tokens: MentionToken[] = mentions.map(id => ({
      id,
      tok: `@${nameForUser(users, id)}`,
    }))
    return renderCommentHtml(body, tokens)
  }, [body, mentions, users])

  const ref = useRef<HTMLDivElement>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let cancelled = false
    const imgs = el.querySelectorAll<HTMLImageElement>(
      'img.flag-attach[data-attachment-id]'
    )
    imgs.forEach(img => {
      const id = Number(img.dataset.attachmentId)
      if (!Number.isFinite(id)) return
      void fetchFlagAttachmentUrl(id).then(url => {
        if (!cancelled && url) img.src = url
      })
    })
    return () => {
      cancelled = true
    }
  }, [html])

  return (
    <>
      <div
        ref={ref}
        className="flag-body text-[13px] leading-relaxed text-foreground/90 [&_p]:m-0 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_.flag-mention]:rounded [&_.flag-mention]:bg-primary/15 [&_.flag-mention]:px-1 [&_.flag-mention]:font-medium [&_.flag-mention]:text-primary [&_img.flag-attach]:mt-1 [&_img.flag-attach]:max-h-48 [&_img.flag-attach]:cursor-pointer [&_img.flag-attach]:rounded [&_img.flag-attach]:border"
        // eslint-disable-next-line react/no-danger -- sanitized by DOMPurify in renderCommentHtml
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={e => {
          const t = e.target as HTMLElement
          if (t.tagName === 'IMG' && t.classList.contains('flag-attach')) {
            setLightbox((t as HTMLImageElement).src)
          }
        }}
      />
      {lightbox && (
        <div
          role="dialog"
          aria-label="attachment preview"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            alt="attachment full size"
            className="max-h-full max-w-full rounded"
          />
        </div>
      )}
    </>
  )
}

export default CommentBody
