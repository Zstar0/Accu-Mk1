/** Is a flag event relevant to `me` (should it raise a notification), and was I
 *  mentioned? Pure — decided entirely from the SSE payload (assignee / creator /
 *  mention). Watching does NOT notify live. The actor is never notified about
 *  their own action. */
export interface RelevanceInput {
  actorId: number | null
  assigneeId: number | null
  createdBy: number
  mentions: number[]
}

export function evaluateRelevance(
  input: RelevanceInput,
  me: number | null
): { relevant: boolean; mentioned: boolean } {
  if (me == null || input.actorId === me) {
    return { relevant: false, mentioned: false }
  }
  const mentioned = input.mentions.includes(me)
  const relevant =
    input.assigneeId === me || input.createdBy === me || mentioned
  return { relevant, mentioned }
}
