import { CrmError } from '@/lib/api-crm'

const MESSAGES: Record<string, string> = {
  not_allowed_to_reply:
    "Plain hasn't allowed Mk1 to send as you yet. Ask an admin to add you to the Mk1 key's impersonation allow list.",
  slack_not_connected:
    'This is a Slack thread and your Slack is not connected in Plain. Reply from Plain or connect Slack there.',
  duplicate_reply: 'Already sent a moment ago.',
  reply_unconfirmed: 'Not confirmed. Check the thread before sending again.',
  no_plain_seat: 'You need a Plain account under your Mk1 email to do this.',
  invalid_input: 'Plain did not accept that. Check the values and try again.',
  thread_not_found: 'This ticket is no longer on this customer.',
  support_not_configured: 'Support actions are not configured on the server.',
}

export function supportErrorMessage(e: unknown): string {
  const known = e instanceof CrmError && e.code ? MESSAGES[e.code] : undefined
  return known ?? 'Plain is unavailable right now. Try again in a moment.'
}
