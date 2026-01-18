/**
 * FileSelector component for selecting HPLC export files.
 * Allows users to select multiple .txt files, preview parsed data,
 * and initiate batch imports.
 */

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { importBatchData } from '@/lib/api'
import type { ParsePreview, FileData } from '@/lib/api'
import { PreviewTable } from './PreviewTable'
import { toast } from 'sonner'
import { FileText, X, Upload, Eye, Loader2 } from 'lucide-react'

export function FileSelector() {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [previews, setPreviews] = useState<ParsePreview[]>([])
  const [importing, setImporting] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (!files) return

    const newFiles = Array.from(files).filter(file => file.name.endsWith('.txt'))
    if (newFiles.length !== files.length) {
      toast.warning('Only .txt files are supported')
    }

    setSelectedFiles(prev => [...prev, ...newFiles])
    // Clear previews when new files are added
    setPreviews([])

    // Reset input so the same file can be selected again
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleRemoveFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
    setPreviews([])
  }

  const handleRemovePreview = (index: number) => {
    setPreviews(prev => prev.filter((_, i) => i !== index))
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }

  const handlePreview = async () => {
    if (selectedFiles.length === 0) {
      toast.error('No files selected')
      return
    }

    setPreviewing(true)
    const newPreviews: ParsePreview[] = []

    for (const file of selectedFiles) {
      try {
        // Read file content and send to backend
        const content = await file.text()

        // Create a temporary path identifier for the backend
        // The backend expects a file path, but we're sending content
        // We need to use a different approach - send content directly
        // For now, we'll create a preview from the file content locally
        // and use the API for actual imports

        // Parse the file content locally for preview
        const lines = content.split('\n').filter(line => line.trim())
        if (lines.length === 0) {
          newPreviews.push({
            filename: file.name,
            headers: [],
            rows: [],
            row_count: 0,
            errors: ['File is empty'],
          })
          continue
        }

        // Assume tab-delimited format (common for HPLC exports)
        const firstLine = lines[0]
        if (!firstLine) {
          newPreviews.push({
            filename: file.name,
            headers: [],
            rows: [],
            row_count: 0,
            errors: ['File is empty'],
          })
          continue
        }
        const headers = firstLine.split('\t').map(h => h.trim())
        const rows: Record<string, string | number | null>[] = []

        for (let i = 1; i < lines.length; i++) {
          const line = lines[i]
          if (!line) continue
          const values = line.split('\t')
          const row: Record<string, string | number | null> = {}
          headers.forEach((header, idx) => {
            const value = values[idx]?.trim() ?? null
            // Try to parse as number
            if (value !== null && value !== '') {
              const num = parseFloat(value)
              row[header] = isNaN(num) ? value : num
            } else {
              row[header] = value
            }
          })
          rows.push(row)
        }

        newPreviews.push({
          filename: file.name,
          headers,
          rows,
          row_count: rows.length,
          errors: [],
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error'
        newPreviews.push({
          filename: file.name,
          headers: [],
          rows: [],
          row_count: 0,
          errors: [message],
        })
      }
    }

    setPreviews(newPreviews)
    setPreviewing(false)

    const successCount = newPreviews.filter(p => p.errors.length === 0).length
    if (successCount === newPreviews.length) {
      toast.success(`Parsed ${successCount} file(s) successfully`)
    } else {
      toast.warning(`Parsed ${successCount}/${newPreviews.length} files`)
    }
  }

  const handleImport = async () => {
    if (previews.length === 0) {
      toast.error('Please preview files first')
      return
    }

    const validPreviews = previews.filter(p => p.errors.length === 0)
    if (validPreviews.length === 0) {
      toast.error('No valid files to import')
      return
    }

    setImporting(true)

    try {
      // Convert previews to FileData format for backend
      const files: FileData[] = validPreviews.map(p => ({
        filename: p.filename,
        headers: p.headers,
        rows: p.rows,
        row_count: p.row_count,
      }))

      const result = await importBatchData(files)

      if (result.errors.length > 0) {
        toast.warning(
          `Imported ${result.samples_created} sample(s) with ${result.errors.length} error(s)`,
          {
            description: result.errors.join(', '),
          }
        )
      } else {
        toast.success(
          `Successfully imported ${result.samples_created} sample(s)`,
          {
            description: `Job ID: ${result.job_id}`,
          }
        )
      }

      // Clear state after successful import
      setSelectedFiles([])
      setPreviews([])
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Import failed'
      toast.error('Import failed', {
        description: message,
      })
    } finally {
      setImporting(false)
    }
  }

  const handleClearAll = () => {
    setSelectedFiles([])
    setPreviews([])
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="size-5" />
            Import HPLC Files
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* File Input */}
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              id="file-input"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="size-4" />
              Select Files
            </Button>
            {selectedFiles.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleClearAll}>
                Clear All
              </Button>
            )}
          </div>

          {/* Selected Files List */}
          {selectedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {selectedFiles.map((file, index) => (
                <Badge
                  key={`${file.name}-${index}`}
                  variant="secondary"
                  className="flex items-center gap-1 px-2 py-1"
                >
                  <FileText className="size-3" />
                  {file.name}
                  <button
                    onClick={() => handleRemoveFile(index)}
                    className="ml-1 rounded-full p-0.5 hover:bg-muted"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          {/* Action Buttons */}
          {selectedFiles.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                onClick={handlePreview}
                disabled={previewing || importing}
                variant="outline"
              >
                {previewing ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Parsing...
                  </>
                ) : (
                  <>
                    <Eye className="size-4" />
                    Preview
                  </>
                )}
              </Button>
              <Button
                onClick={handleImport}
                disabled={previews.length === 0 || importing || previewing}
              >
                {importing ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Upload className="size-4" />
                    Import {previews.length > 0 ? `(${previews.filter(p => p.errors.length === 0).length})` : ''}
                  </>
                )}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Preview Tables */}
      {previews.length > 0 && (
        <div className="flex flex-col gap-4">
          {previews.map((preview, index) => (
            <PreviewTable
              key={`${preview.filename}-${index}`}
              preview={preview}
              onRemove={() => handleRemovePreview(index)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
