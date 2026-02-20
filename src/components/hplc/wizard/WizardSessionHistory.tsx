import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { listWizardSessions, type WizardSessionListItem } from '@/lib/api'

export function WizardSessionHistory() {
  const [items, setItems] = useState<WizardSessionListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listWizardSessions({ status: 'completed', limit: 50 })
      .then(data => {
        if (!cancelled) setItems(data)
      })
      .catch(err => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load sessions'
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-destructive py-4">{error}</p>
    )
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No completed wizard sessions yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Sample ID</th>
                <th className="pb-2 pr-4 font-medium">Status</th>
                <th className="pb-2 pr-4 font-medium text-right">
                  Declared Weight (mg)
                </th>
                <th className="pb-2 pr-4 font-medium">Created</th>
                <th className="pb-2 font-medium">Completed</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr
                  key={item.id}
                  className="border-b last:border-0 hover:bg-muted/50 transition-colors"
                >
                  <td className="py-2.5 pr-4 font-medium">
                    {item.sample_id_label ?? '—'}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge variant="outline">{item.status}</Badge>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums">
                    {item.declared_weight_mg != null
                      ? item.declared_weight_mg.toFixed(2)
                      : '—'}
                  </td>
                  <td className="py-2.5 pr-4 text-muted-foreground">
                    {new Date(item.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-2.5 text-muted-foreground">
                    {item.completed_at != null
                      ? new Date(item.completed_at).toLocaleDateString()
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  )
}
