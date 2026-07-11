/**
 * Reaction bar + pills for one comment. Hover reveals the curated set; existing
 * reactions render as pills (count + who-tooltip). Clicking toggles my own
 * reaction. Names resolve client-side (module purity); reacted-by-me derives
 * from user_ids vs currentUserId.
 */
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useAddReaction, useRemoveReaction } from '@/hooks/use-flags'
import { useFlagUsers, nameForUser } from '@/components/flags/flag-users'
import { FLAG_REACTION_EMOJI, type ReactionAggregate } from '@/lib/flags-api'
import { cn } from '@/lib/utils'

export function FlagReactions({
  commentId,
  flagId,
  currentUserId,
  reactions,
}: {
  commentId: number
  flagId: number
  currentUserId: number | null
  reactions: ReactionAggregate[]
}) {
  const users = useFlagUsers()
  const add = useAddReaction(flagId)
  const remove = useRemoveReaction(flagId)

  const toggle = (emoji: string, mine: boolean) =>
    (mine ? remove : add).mutate({ commentId, emoji })

  return (
    <TooltipProvider delayDuration={200}>
      {/* The hover group that reveals the picker is the COMMENT WRAPPER
          (`group/react` in FlagThread, both view modes) — not this bar. With
          zero reactions this bar is a near-zero-height strip nobody can find
          to hover (live-review discoverability bug). */}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {reactions.map(r => {
          const mine =
            currentUserId != null && r.user_ids.includes(currentUserId)
          const who = r.user_ids.map(id => nameForUser(users, id)).join(', ')
          return (
            <Tooltip key={r.emoji}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${r.emoji} ${r.count}`}
                  onClick={() => toggle(r.emoji, mine)}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]',
                    mine
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'text-muted-foreground'
                  )}
                >
                  <span>{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="font-mono text-[11px]">
                {who}
              </TooltipContent>
            </Tooltip>
          )
        })}

        <div className="hidden items-center gap-0.5 group-hover/react:flex">
          {FLAG_REACTION_EMOJI.map(emoji => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              onClick={() =>
                toggle(
                  emoji,
                  currentUserId != null &&
                    (reactions
                      .find(r => r.emoji === emoji)
                      ?.user_ids.includes(currentUserId) ??
                      false)
                )
              }
              className="rounded px-1 text-[13px] opacity-70 hover:opacity-100"
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </TooltipProvider>
  )
}

export default FlagReactions
