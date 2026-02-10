import { useState, useRef } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import {
  Upload,
  FileSpreadsheet,
  Trash2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ChromatogramData {
  time: number
  mAU: number
}

interface ParsedFile {
  name: string
  data: ChromatogramData[]
  color: string
}

// Default colors for multiple chromatograms
const CHART_COLORS = [
  '#2563eb', // blue-600
  '#dc2626', // red-600
  '#16a34a', // green-600
  '#9333ea', // purple-600
  '#ea580c', // orange-600
]

/**
 * Parse CSV content into chromatogram data.
 * Expects columns: time, mAU (or similar headers)
 */
function parseCSV(content: string): ChromatogramData[] {
  const lines = content.trim().split('\n')
  if (lines.length < 2) return []

  // Try to detect the delimiter
  const delimiter = lines[0]?.includes('\t') ? '\t' : ','

  // Parse header to find column indices
  const header =
    lines[0]
      ?.toLowerCase()
      .split(delimiter)
      .map(h => h.trim()) ?? []
  let timeIndex = header.findIndex(
    h => h.includes('time') || h.includes('min') || h === 'x'
  )
  let mAUIndex = header.findIndex(
    h =>
      h.includes('mau') ||
      h.includes('absorbance') ||
      h.includes('intensity') ||
      h === 'y'
  )

  // If no header detected, assume first two columns are time, mAU
  if (timeIndex === -1) timeIndex = 0
  if (mAUIndex === -1) mAUIndex = 1

  // Skip header row if it looks like text
  const startRow = isNaN(
    parseFloat(lines[0]?.split(delimiter)[timeIndex] ?? '')
  )
    ? 1
    : 0

  const data: ChromatogramData[] = []
  for (let i = startRow; i < lines.length; i++) {
    const cols = lines[i]?.split(delimiter)
    if (!cols || cols.length < 2) continue

    const time = parseFloat(cols[timeIndex] ?? '')
    const mAU = parseFloat(cols[mAUIndex] ?? '')

    if (!isNaN(time) && !isNaN(mAU)) {
      data.push({ time, mAU })
    }
  }

  return data
}

export function ChromatographViewer() {
  const [files, setFiles] = useState<ParsedFile[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [yDomain, setYDomain] = useState<[number, number] | undefined>(
    undefined
  )
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = async (selectedFiles: FileList | null) => {
    if (!selectedFiles) return

    const newFiles: ParsedFile[] = []

    for (const file of selectedFiles) {
      const content = await file.text()
      const data = parseCSV(content)

      if (data.length > 0) {
        newFiles.push({
          name: file.name,
          data,
          color:
            CHART_COLORS[
              (files.length + newFiles.length) % CHART_COLORS.length
            ] ??
            CHART_COLORS[0] ??
            '#8884d8',
        })
      }
    }

    setFiles(prev => [...prev, ...newFiles])
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    handleFileSelect(e.dataTransfer.files)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
  }

  const clearAll = () => {
    setFiles([])
    setYDomain(undefined)
  }

  const zoomIn = () => {
    if (yDomain === undefined) {
      const maxY = Math.max(...files.flatMap(f => f.data.map(d => d.mAU)))
      setYDomain([0, maxY * 0.5])
    } else {
      setYDomain([yDomain[0], yDomain[1] * 0.5])
    }
  }

  const zoomOut = () => {
    if (yDomain === undefined) return
    setYDomain([yDomain[0], yDomain[1] * 2])
  }

  const resetZoom = () => {
    setYDomain(undefined)
  }

  // Combine all data for the chart
  const hasData = files.length > 0

  return (
    <div className="flex flex-col gap-6 p-6 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Chromatograph Viewer</h2>
          <p className="text-sm text-muted-foreground">
            Upload CSV files to visualize HPLC chromatograms
          </p>
        </div>

        {hasData && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={zoomIn}
              title="Zoom In"
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={zoomOut}
              title="Zoom Out"
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={resetZoom}
              title="Reset Zoom"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button variant="outline" onClick={clearAll}>
              <Trash2 className="h-4 w-4 mr-2" />
              Clear All
            </Button>
          </div>
        )}
      </div>

      {/* File upload area */}
      <Card
        className={cn(
          'border-2 border-dashed transition-colors cursor-pointer',
          isDragging
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/25 hover:border-primary/50'
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
      >
        <CardContent className="flex flex-col items-center justify-center py-8">
          <Upload className="h-10 w-10 text-muted-foreground mb-4" />
          <p className="text-sm font-medium">
            Drop CSV files here or click to browse
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Supports CSV/TSV with time and mAU columns
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt"
            multiple
            className="hidden"
            onChange={e => handleFileSelect(e.target.files)}
          />
        </CardContent>
      </Card>

      {/* Loaded files list */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file, index) => (
            <div
              key={`${file.name}-${index}`}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-secondary text-sm"
            >
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: file.color }}
              />
              <FileSpreadsheet className="h-4 w-4" />
              <span className="max-w-[200px] truncate">{file.name}</span>
              <span className="text-muted-foreground">
                ({file.data.length} pts)
              </span>
              <button
                onClick={e => {
                  e.stopPropagation()
                  removeFile(index)
                }}
                className="hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      {hasData && (
        <Card className="flex-1 min-h-[400px]">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Chromatogram</CardTitle>
            <CardDescription>
              {files.length} file{files.length > 1 ? 's' : ''} loaded
            </CardDescription>
          </CardHeader>
          <CardContent className="h-[calc(100%-80px)]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart margin={{ top: 20, right: 30, left: 20, bottom: 30 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(value: number) => value.toFixed(1)}
                  label={{
                    value: 'Time [min]',
                    position: 'bottom',
                    offset: 10,
                    style: { fill: 'currentColor' },
                  }}
                  stroke="currentColor"
                  tick={{ fill: 'currentColor' }}
                  fontSize={12}
                  allowDuplicatedCategory={false}
                />
                <YAxis
                  domain={yDomain}
                  tickFormatter={(value: number) => value.toFixed(0)}
                  label={{
                    value: 'mAU',
                    angle: -90,
                    position: 'insideLeft',
                    offset: 10,
                    style: { fill: 'currentColor' },
                  }}
                  stroke="currentColor"
                  tick={{ fill: 'currentColor' }}
                  fontSize={12}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--background))',
                    borderColor: 'hsl(var(--border))',
                    color: 'hsl(var(--foreground))',
                    borderRadius: '6px',
                    fontSize: '12px',
                  }}
                />
                <ReferenceLine
                  y={0}
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth={1}
                />

                {files.map((file, index) => (
                  <Line
                    key={`${file.name}-${index}`}
                    data={file.data}
                    dataKey="mAU"
                    stroke={file.color}
                    strokeWidth={1.5}
                    dot={false}
                    name={file.name}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!hasData && (
        <Card className="flex-1 flex items-center justify-center min-h-[400px]">
          <div className="text-center text-muted-foreground">
            <FileSpreadsheet className="h-16 w-16 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium">No chromatograms loaded</p>
            <p className="text-sm">Upload a CSV file to get started</p>
          </div>
        </Card>
      )}
    </div>
  )
}
