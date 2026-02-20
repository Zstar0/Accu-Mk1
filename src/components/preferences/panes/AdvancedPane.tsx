import { useState } from 'react'
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react'
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
  const [wiping, setWiping] = useState(false)

  const handleWipe = async () => {
    setWiping(true)
    try {
      const token = getAuthToken()
      const response = await fetch(`${getApiBaseUrl()}/peptides/wipe-all`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.detail || `Request failed: ${response.status}`)
      }
      const data = await response.json()
      toast.success('Wipe complete', {
        description: `${data.peptides_deleted} peptides, ${data.curves_deleted} curves, and ${data.cache_deleted} cached files cleared`,
      })
    } catch (err) {
      toast.error('Wipe failed', { description: String(err) })
    } finally {
      setWiping(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="HPLC Standards">
        <SettingsField
          label="Wipe Standards"
          description="Delete all existing peptide standards and calibration curves. Use Import Standards on the Peptide Standards page afterward to re-import from SharePoint."
        >
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={wiping}
                className="gap-2"
              >
                {wiping ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                {wiping ? 'Wiping...' : 'Wipe Standards'}
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
                  curves. Any manual edits (reference RT, tolerance, wizard fields)
                  will be lost.
                  <br />
                  <br />
                  You can re-import from SharePoint afterward using{' '}
                  <strong>Import Standards</strong> on the Peptide Standards page.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleWipe}
                >
                  Yes, wipe all standards
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SettingsField>
      </SettingsSection>
    </div>
  )
}
