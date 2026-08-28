// Clickable tracking number for receive-list rows. stopPropagation is
// load-bearing: both host tables put onClick on the whole row (opens the
// receive wizard) and a tracking click must not also do that.
export function TrackingLink({
  trackingNumber,
  trackingUrl,
}: {
  trackingNumber?: string | null
  trackingUrl?: string | null
}) {
  if (!trackingNumber) return <span>—</span>
  if (!trackingUrl) return <span className="font-mono">{trackingNumber}</span>
  return (
    <a
      href={trackingUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-primary hover:underline"
      onClick={e => e.stopPropagation()}
    >
      {trackingNumber}
    </a>
  )
}
