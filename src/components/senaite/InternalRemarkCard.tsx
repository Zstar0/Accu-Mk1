import DOMPurify from 'dompurify'
import { EyeOff, User } from 'lucide-react'

interface InternalRemarkCardProps {
  author: string
  createdLabel: string
  content: string
}

const ALLOWED_TAGS = ['a', 'b', 'i', 'em', 'strong', 'br', 'p', 'span']
const ALLOWED_ATTR = ['href', 'target', 'rel', 'class']

/** A single lab-internal remark, styled as a warm amber "internal note" (the
 *  Flags guide callout scheme) with an explicit not-shared-with-customer
 *  caption. Presentational — the caller formats the date and passes primitives. */
export function InternalRemarkCard({
  author,
  createdLabel,
  content,
}: InternalRemarkCardProps) {
  return (
    <div className="rounded-lg border-l-4 border-amber-500 bg-amber-100 p-3 dark:border-amber-600 dark:bg-[#3f2f0c]">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-200 dark:bg-amber-800/40">
            <User size={11} className="text-amber-700 dark:text-amber-300" />
          </div>
          <span className="text-xs font-medium text-amber-900 dark:text-amber-200">
            {author}
          </span>
        </div>
        <span className="text-[11px] text-amber-700 dark:text-amber-300/80">
          {createdLabel}
        </span>
      </div>
      <p
        className="pl-7 text-sm text-amber-900 dark:text-amber-200 [&_a]:text-blue-700 [&_a]:underline dark:[&_a]:text-blue-400"
        dangerouslySetInnerHTML={{
          __html: DOMPurify.sanitize(content, {
            ALLOWED_TAGS,
            ALLOWED_ATTR,
          }),
        }}
      />
      <div className="mt-1.5 flex items-center gap-1 pl-7 text-[11px] text-amber-700 dark:text-amber-300/80">
        <EyeOff size={11} aria-hidden="true" />
        Internal — not shared with the customer
      </div>
    </div>
  )
}

export default InternalRemarkCard
