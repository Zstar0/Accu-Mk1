/**
 * Local-folder source for HPLC prep processing. Pick a folder; its
 * *_PeakData.csv / *_DAD1A.csv files are read client-side (no upload) and
 * handed to the caller as LocalHplcFile[]. Web file API — works on the desktop
 * app (webview) and the web app alike.
 */
import { useRef, useState } from 'react'
import { FolderOpen, Loader2, AlertCircle, HardDrive } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { readLocalHplcFolder, type LocalHplcFile } from './hplc-local-files'

interface Props {
  onSelected: (folderName: string, localFiles: LocalHplcFile[]) => void
  disabled?: boolean
}

export function LocalHplcFolderPicker({ onSelected, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files
    if (!list || list.length === 0) return
    setReading(true)
    setError(null)
    try {
      const { folderName, localFiles } = await readLocalHplcFolder(Array.from(list))
      const peakCount = localFiles.filter(f => f.kind === 'peak').length
      if (peakCount === 0) {
        setError(`No *_PeakData.csv files in "${folderName}". Pick a folder with HPLC PeakData exports.`)
        return
      }
      onSelected(folderName, localFiles)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read the selected folder')
    } finally {
      setReading(false)
      if (inputRef.current) inputRef.current.value = '' // allow re-picking the same folder
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 text-emerald-500" />
          <CardTitle className="text-base">Local files</CardTitle>
        </div>
        <CardDescription>
          Choose a folder on this machine — its PeakData / DAD1A CSVs are read here and pinned to the prep (this session only; nothing is uploaded).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* webkitdirectory is non-standard; cast to satisfy TS */}
        <input
          ref={inputRef}
          data-testid="local-folder-input"
          type="file"
          className="hidden"
          multiple
          onChange={handleChange}
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        />
        <Button
          variant="outline"
          disabled={disabled || reading}
          onClick={() => inputRef.current?.click()}
        >
          {reading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FolderOpen className="h-4 w-4 mr-2" />}
          Choose folder…
        </Button>
        {error && (
          <div className="flex items-center gap-2 p-3 mt-3 rounded-md bg-destructive/10 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
