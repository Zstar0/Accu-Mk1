import { useState } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import { getApiBaseUrl } from '@/lib/config'
import { getAuthToken } from '@/store/auth-store'
import { toast } from 'sonner'

export function AdvancedPane() {
  const [rebuilding, setRebuilding] = useState(false)

  const handleWipeAndRebuild = async () => {
    setRebuilding(true)
    try {
      const token = getAuthToken()
      const response = await fetch(`${getApiBaseUrl()}/hplc/rebuild-standards/stream`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok || !response.body) {
        throw new Error(`Request failed: ${response.status}`)
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const dataLine = part.split('\n').find(l => l.startsWith('data:'))
          const eventLine = part.split('\n').find(l => l.startsWith('event:'))
          if (!dataLine) continue
          try {
            const payload = JSON.parse(dataLine.slice(5).trim())
            const eventType = eventLine?.slice(6).trim()
            if (eventType === 'done') {
              if (payload.success) {
                toast.success('Rebuild complete', {
                  description: `${payload.peptides ?? 0} peptides · ${payload.curves ?? 0} curves imported`,
                })
              } else {
                toast.error('Rebuild failed', { description: payload.error })
              }
            }
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (err) {
      toast.error('Rebuild failed', { description: String(err) })
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="HPLC Standards">
        <SettingsField
          label="Wipe & Rebuild Standards"
          description="Delete all existing peptide standards and curves, then re-import everything from SharePoint. Use this to fix corrupted data or after major folder restructuring."
        >
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={rebuilding}
                className="gap-2"
              >
                {rebuilding ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {rebuilding ? 'Rebuilding...' : 'Wipe & Rebuild'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  Wipe all peptide standards?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all peptide records and calibration
                  curves, then re-import from SharePoint from scratch. Any manual
                  edits (reference RT, tolerance, wizard fields) will be lost.
                  <br />
                  <br />
                  Use <strong>Import Standards</strong> on the Peptide Standards
                  page to incrementally add only new files instead.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleWipeAndRebuild}
                >
                  Yes, wipe and rebuild
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SettingsField>
      </SettingsSection>
    </div>
  )
}
