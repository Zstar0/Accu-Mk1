import { useState, useCallback, useEffect } from 'react'
import {
  Upload,
  FolderOpen,
  FileText,
  X,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PeakTable } from './PeakTable'
import { PeptideSelector } from './PeptideSelector'
import { WeightsForm } from './WeightsForm'
import { AnalysisResults } from './AnalysisResults'
import {
  ChromatogramChart,
  parseChromatogramCsv,
  downsampleLTTB,
  type ChromatogramTrace,
} from './ChromatogramChart'
import {
  parseHPLCFiles,
  runHPLCAnalysis,
  fetchSampleWeights,
  type HPLCParseResult,
  type HPLCWeightsInput,
  type HPLCAnalysisResult,
  type PeptideRecord,
  type WeightExtractionResult,
} from '@/lib/api'

type Step = 'parse' | 'configure' | 'results'

interface FileEntry {
  file: File
  name: string
}

const EMPTY_WEIGHTS: HPLCWeightsInput = {
  stock_vial_empty: 0,
  stock_vial_with_diluent: 0,
  dil_vial_empty: 0,
  dil_vial_with_diluent: 0,
  dil_vial_with_diluent_and_sample: 0,
}

export function NewAnalysis() {
  // Step state
  const [step, setStep] = useState<Step>('parse')

  // Step 1: Parse
  const [files, setFiles] = useState<FileEntry[]>([])
  const [parsing, setParsing] = useState(false)
  const [parseResult, setParseResult] = useState<HPLCParseResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanProgress, setScanProgress] = useState<{
    total: number
    processed: number
    filesFound: number
  } | null>(null)
  const [chromatograms, setChromatograms] = useState<ChromatogramTrace[]>([])

  // Step 2: Configure
  const [sampleId, setSampleId] = useState('')
  const [selectedPeptide, setSelectedPeptide] = useState<PeptideRecord | null>(
    null
  )
  const [weights, setWeights] = useState<HPLCWeightsInput>(EMPTY_WEIGHTS)
  const [weightData, setWeightData] = useState<WeightExtractionResult | null>(null)
  const [weightsFetched, setWeightsFetched] = useState(false)

  // Step 3: Results
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisResult, setAnalysisResult] =
    useState<HPLCAnalysisResult | null>(null)

  // Auto-fetch weights from lab folder when entering configure step
  useEffect(() => {
    if (step !== 'configure' || !sampleId || weightsFetched) return
    setWeightsFetched(true)

    fetchSampleWeights(sampleId)
      .then(data => {
        setWeightData(data)
        if (data.found && data.dilution_rows.length > 0) {
          // Auto-populate stock weights + first dilution row
          const firstDil = data.dilution_rows[0]!
          setWeights({
            stock_vial_empty: data.stock_vial_empty ?? 0,
            stock_vial_with_diluent: data.stock_vial_with_diluent ?? 0,
            dil_vial_empty: firstDil.dil_vial_empty,
            dil_vial_with_diluent: firstDil.dil_vial_with_diluent,
            dil_vial_with_diluent_and_sample: firstDil.dil_vial_with_diluent_and_sample,
          })
        }
      })
      .catch(() => {
        // Silent fail — user can still enter manually
      })
  }, [step, sampleId, weightsFetched])

  // --- Helpers ---
  const extractSampleId = (filename: string): string | null => {
    // Match P-XXXX pattern from filenames like "P-0142_Inj_1_PeakData.csv"
    const match = filename.match(/^(P-\d+)/i)
    return match?.[1]?.toUpperCase() ?? null
  }

  const isPeakDataCsv = (name: string) => {
    const lower = name.toLowerCase()
    return lower.endsWith('.csv') && lower.includes('peakdata')
  }

  const isChromatogramCsv = (name: string) => {
    const lower = name.toLowerCase()
    return lower.endsWith('.csv') && lower.includes('dx_dad1a')
  }

  const readEntryAsFile = (entry: FileSystemFileEntry): Promise<File> =>
    new Promise((resolve, reject) => entry.file(resolve, reject))

  const readDirectory = (
    dirEntry: FileSystemDirectoryEntry
  ): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => {
      const reader = dirEntry.createReader()
      const allEntries: FileSystemEntry[] = []
      const readBatch = () => {
        reader.readEntries(entries => {
          if (entries.length === 0) {
            resolve(allEntries)
          } else {
            allEntries.push(...entries)
            readBatch()
          }
        }, reject)
      }
      readBatch()
    })

  const collectCsvFiles = async (
    entry: FileSystemEntry,
    onProgress?: (filesFound: number) => void,
    _found = { count: 0 },
    chromCollector?: File[],
  ): Promise<File[]> => {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry
      if (isPeakDataCsv(entry.name)) {
        _found.count++
        onProgress?.(_found.count)
        return [await readEntryAsFile(fileEntry)]
      }
      if (isChromatogramCsv(entry.name)) {
        chromCollector?.push(await readEntryAsFile(fileEntry))
        return []
      }
      if (entry.name.toLowerCase().endsWith('.csv')) {
        _found.count++
        onProgress?.(_found.count)
        return [await readEntryAsFile(fileEntry)]
      }
      return []
    }
    if (entry.isDirectory) {
      const dirEntry = entry as FileSystemDirectoryEntry
      const children = await readDirectory(dirEntry)
      const results: File[] = []
      for (const child of children) {
        if (child.isFile && isPeakDataCsv(child.name)) {
          results.push(await readEntryAsFile(child as FileSystemFileEntry))
          _found.count++
          onProgress?.(_found.count)
        } else if (child.isFile && isChromatogramCsv(child.name)) {
          chromCollector?.push(await readEntryAsFile(child as FileSystemFileEntry))
        } else if (child.isDirectory) {
          results.push(...(await collectCsvFiles(child, onProgress, _found, chromCollector)))
        }
      }
      return results
    }
    return []
  }

  // --- Step 1 handlers ---
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()

    // Check if any dropped items are directories
    const items = Array.from(e.dataTransfer.items)
    const entries = items
      .map(item => item.webkitGetAsEntry?.())
      .filter((e): e is FileSystemEntry => e !== null && e !== undefined)

    const hasDirectories = entries.some(e => e.isDirectory)

    let csvFiles: File[]
    if (hasDirectories) {
      // Count top-level items for progress estimation
      let totalItems = 0
      for (const entry of entries) {
        if (entry.isDirectory) {
          const children = await readDirectory(entry as FileSystemDirectoryEntry)
          totalItems += children.length
        } else {
          totalItems++
        }
      }
      setScanProgress({ total: totalItems, processed: 0, filesFound: 0 })

      // Recursively scan folders for PeakData + chromatogram CSVs with progress
      const allFiles: File[] = []
      const chromFiles: File[] = []
      let processed = 0
      const tracker = { count: 0 }
      for (const entry of entries) {
        if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry
          const children = await readDirectory(dirEntry)
          for (const child of children) {
            if (child.isFile && isPeakDataCsv(child.name)) {
              allFiles.push(await readEntryAsFile(child as FileSystemFileEntry))
              tracker.count++
            } else if (child.isFile && isChromatogramCsv(child.name)) {
              chromFiles.push(await readEntryAsFile(child as FileSystemFileEntry))
            } else if (child.isDirectory) {
              allFiles.push(...(await collectCsvFiles(child, (n) => {
                setScanProgress(p => p ? { ...p, filesFound: n } : null)
              }, tracker, chromFiles)))
            }
            processed++
            setScanProgress(p => p ? { ...p, processed, filesFound: tracker.count } : null)
          }
        } else if (
          entry.isFile &&
          entry.name.toLowerCase().endsWith('.csv')
        ) {
          if (isChromatogramCsv(entry.name)) {
            chromFiles.push(await readEntryAsFile(entry as FileSystemFileEntry))
          } else {
            allFiles.push(await readEntryAsFile(entry as FileSystemFileEntry))
          }
          processed++
          tracker.count++
          setScanProgress(p => p ? { ...p, processed, filesFound: tracker.count } : null)
        }
      }
      setScanProgress(null)
      csvFiles = allFiles

      // Parse chromatogram files into traces
      if (chromFiles.length > 0) {
        const traces: ChromatogramTrace[] = []
        for (const f of chromFiles) {
          const text = await f.text()
          const raw = parseChromatogramCsv(text)
          if (raw.length > 0) {
            const points = downsampleLTTB(raw, 1500)
            // Extract injection name (e.g. "P-0142_Inj_1.dx_DAD1A.CSV" → "Inj 1")
            const injMatch = f.name.match(/Inj[_\s]*(\d+)/i)
            const name = injMatch ? `Inj ${injMatch[1]}` : f.name.replace(/\.csv$/i, '')
            traces.push({ name, points })
          }
        }
        traces.sort((a, b) => a.name.localeCompare(b.name))
        setChromatograms(traces)
      }
    } else {
      // Plain file drop — accept any CSV
      csvFiles = Array.from(e.dataTransfer.files).filter(f =>
        f.name.toLowerCase().endsWith('.csv')
      )
    }

    if (csvFiles.length === 0) {
      setError(
        hasDirectories
          ? 'No PeakData CSV files found in the dropped folder(s).'
          : 'No CSV files found. Drop .csv files or a folder containing them.'
      )
      return
    }

    // Auto-detect sample ID from folder name or first filename
    if (!sampleId) {
      let detectedId: string | null = null
      // Try dropped folder names first (e.g. "P-0110 AOD-9604")
      for (const entry of entries) {
        if (entry.isDirectory) {
          detectedId = extractSampleId(entry.name)
          if (detectedId) break
        }
      }
      // Fall back to CSV filenames
      if (!detectedId) {
        for (const f of csvFiles) {
          detectedId = extractSampleId(f.name)
          if (detectedId) break
        }
      }
      if (detectedId) setSampleId(detectedId)
    }

    setFiles(prev => {
      const existing = new Set(prev.map(f => f.name))
      const newFiles = csvFiles
        .filter(f => !existing.has(f.name))
        .map(f => ({ file: f, name: f.name }))
      return [...prev, ...newFiles]
    })
    setParseResult(null)
    setError(null)
  }, [sampleId])

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files
      if (!selected) return
      const csvFiles = Array.from(selected).filter(f =>
        f.name.toLowerCase().endsWith('.csv')
      )
      if (!sampleId) {
        for (const f of csvFiles) {
          const id = extractSampleId(f.name)
          if (id) {
            setSampleId(id)
            break
          }
        }
      }
      setFiles(prev => {
        const existing = new Set(prev.map(f => f.name))
        const newFiles = csvFiles
          .filter(f => !existing.has(f.name))
          .map(f => ({ file: f, name: f.name }))
        return [...prev, ...newFiles]
      })
      setParseResult(null)
      setError(null)
      e.target.value = ''
    },
    [sampleId]
  )

  const removeFile = useCallback((name: string) => {
    setFiles(prev => prev.filter(f => f.name !== name))
    setParseResult(null)
  }, [])

  const handleParse = useCallback(async () => {
    if (files.length === 0) return
    setParsing(true)
    setError(null)
    setParseResult(null)

    try {
      const fileData = await Promise.all(
        files.map(async ({ file, name }) => {
          const content = await file.text()
          return { filename: name, content }
        })
      )
      const result = await parseHPLCFiles(fileData)
      setParseResult(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse files')
    } finally {
      setParsing(false)
    }
  }, [files])

  // --- Step 2 → 3: Run analysis ---
  const handleAnalyze = useCallback(async () => {
    if (!parseResult || !selectedPeptide) return
    setAnalyzing(true)
    setError(null)

    try {
      const result = await runHPLCAnalysis({
        sample_id_label: sampleId.trim() || 'Unknown',
        peptide_id: selectedPeptide.id,
        weights,
        injections: parseResult.injections as unknown as Record<
          string,
          unknown
        >[],
      })
      setAnalysisResult(result)
      setStep('results')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setAnalyzing(false)
    }
  }, [parseResult, selectedPeptide, sampleId, weights])

  const handleReset = useCallback(() => {
    setStep('parse')
    setFiles([])
    setParseResult(null)
    setError(null)
    setScanProgress(null)
    setChromatograms([])
    setSampleId('')
    setSelectedPeptide(null)
    setWeights(EMPTY_WEIGHTS)
    setWeightData(null)
    setWeightsFetched(false)
    setAnalysisResult(null)
  }, [])

  const canProceedToConfigure =
    parseResult !== null && parseResult.injections.length > 0
  const canRunAnalysis =
    selectedPeptide !== null &&
    selectedPeptide.active_calibration !== null &&
    weights.stock_vial_empty > 0 &&
    weights.dil_vial_with_diluent_and_sample > 0

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header with step indicator */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">New Analysis</h1>
            <p className="text-muted-foreground">
              {step === 'parse' && 'Step 1: Drop PeakData CSV files and parse peaks.'}
              {step === 'configure' && 'Step 2: Select peptide and enter sample weights.'}
              {step === 'results' && 'Step 3: Analysis complete.'}
            </p>
          </div>
          <div className="flex items-center gap-1 text-sm">
            <StepDot active={step === 'parse'} done={step !== 'parse'} label="1. Parse" />
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <StepDot active={step === 'configure'} done={step === 'results'} label="2. Configure" />
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <StepDot active={step === 'results'} done={false} label="3. Results" />
          </div>
        </div>

        {/* Error */}
        {error && (
          <Card className="border-destructive">
            <CardContent className="flex items-center gap-2 pt-6">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <span className="text-sm text-destructive">{error}</span>
            </CardContent>
          </Card>
        )}

        {/* STEP 1: Parse */}
        {step === 'parse' && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">PeakData Files</CardTitle>
                <CardDescription>
                  Drop CSV files containing peak data. Supports multiple injections.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div
                  onDrop={handleDrop}
                  onDragOver={e => e.preventDefault()}
                  className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/50 p-6 transition-colors hover:border-primary/50 hover:bg-muted"
                  onClick={() =>
                    document.getElementById('hplc-file-input')?.click()
                  }
                >
                  <div className="flex items-center gap-3 text-muted-foreground/50">
                    <Upload className="h-8 w-8" />
                    <FolderOpen className="h-8 w-8" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Drop CSV files or a folder — PeakData files are found automatically
                  </p>
                  <p className="text-xs text-muted-foreground/60">
                    or click to browse for individual files
                  </p>
                  <input
                    id="hplc-file-input"
                    type="file"
                    accept=".csv"
                    multiple
                    className="hidden"
                    onChange={handleFileInput}
                  />
                </div>

                {/* Folder scan progress */}
                {scanProgress && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Scanning folder...
                      </span>
                      <span className="font-mono">
                        {scanProgress.filesFound} PeakData file{scanProgress.filesFound !== 1 ? 's' : ''} found
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-200"
                        style={{
                          width: `${scanProgress.total > 0 ? Math.round((scanProgress.processed / scanProgress.total) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {files.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {files.map(f => (
                      <div
                        key={f.name}
                        className="flex items-center gap-2 rounded-md border bg-card px-3 py-2"
                      >
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <span className="flex-1 truncate text-sm">
                          {f.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFile(f.name)}
                          className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    onClick={handleParse}
                    disabled={files.length === 0 || parsing}
                  >
                    {parsing && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {parsing ? 'Parsing...' : 'Parse Files'}
                  </Button>
                  {files.length > 0 && (
                    <Button variant="outline" onClick={handleReset}>
                      Clear
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Parse warnings */}
            {parseResult && parseResult.errors.length > 0 && (
              <Card className="border-orange-500/50">
                <CardContent className="pt-6">
                  <ul className="list-inside list-disc text-sm text-orange-600">
                    {parseResult.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Parsed results preview */}
            {parseResult && parseResult.injections.length > 0 && (
              <>
                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-5 w-5 text-green-600" />
                      <CardTitle className="text-base">
                        Purity (preview)
                      </CardTitle>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-baseline gap-6">
                      <div>
                        <span className="text-4xl font-bold tabular-nums">
                          {parseResult.purity.purity_percent != null
                            ? parseResult.purity.purity_percent.toFixed(2)
                            : '—'}
                        </span>
                        <span className="ml-1 text-2xl text-muted-foreground">
                          %
                        </span>
                      </div>
                      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                        {parseResult.purity.individual_values.map((val, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Badge
                              variant="outline"
                              className="font-mono text-xs"
                            >
                              {parseResult.purity.injection_names[i]}
                            </Badge>
                            <span className="font-mono">
                              {val.toFixed(4)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {chromatograms.length > 0 && (
                  <ChromatogramChart
                    traces={chromatograms}
                    peakRTs={parseResult.injections[0]?.peaks
                      .filter(p => !p.is_solvent_front)
                      .map(p => p.retention_time)}
                  />
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Peak Data</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Tabs
                      defaultValue={
                        parseResult.injections[0]?.injection_name
                      }
                    >
                      <TabsList>
                        {parseResult.injections.map(inj => (
                          <TabsTrigger
                            key={inj.injection_name}
                            value={inj.injection_name}
                          >
                            {inj.injection_name}
                            <Badge
                              variant="secondary"
                              className="ml-2 text-xs"
                            >
                              {inj.peaks.length}
                            </Badge>
                          </TabsTrigger>
                        ))}
                      </TabsList>
                      {parseResult.injections.map(inj => (
                        <TabsContent
                          key={inj.injection_name}
                          value={inj.injection_name}
                        >
                          <PeakTable
                            peaks={inj.peaks}
                            totalArea={inj.total_area}
                          />
                        </TabsContent>
                      ))}
                    </Tabs>
                  </CardContent>
                </Card>

                <div className="flex justify-end">
                  <Button
                    onClick={() => setStep('configure')}
                    disabled={!canProceedToConfigure}
                    className="gap-2"
                  >
                    Next: Configure Analysis
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              </>
            )}
          </>
        )}

        {/* STEP 2: Configure */}
        {step === 'configure' && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sample & Peptide</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="space-y-2">
                  <Label>Sample ID</Label>
                  <Input
                    placeholder="e.g., P-0142"
                    value={sampleId}
                    onChange={e => setSampleId(e.target.value)}
                  />
                </div>
                <PeptideSelector
                  value={selectedPeptide?.id ?? null}
                  onChange={setSelectedPeptide}
                  autoSelectFolder={weightData?.peptide_folder}
                />
                {selectedPeptide && !selectedPeptide.active_calibration && (
                  <p className="text-sm text-destructive">
                    This peptide has no active calibration curve. Add one in
                    Peptide Config first.
                  </p>
                )}
                {selectedPeptide?.active_calibration && (
                  <div className="rounded-md bg-muted/50 p-3 text-sm">
                    <p className="font-mono">
                      Area = {selectedPeptide.active_calibration.slope.toFixed(4)}{' '}
                      × Conc +{' '}
                      {selectedPeptide.active_calibration.intercept.toFixed(4)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      R² ={' '}
                      {selectedPeptide.active_calibration.r_squared.toFixed(6)}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Balance Weights</CardTitle>
                    <CardDescription>
                      {weightData?.found && weightData.dilution_rows.length > 0
                        ? `Auto-loaded from ${weightData.excel_filename}`
                        : 'Enter the 5 weights from sample preparation.'}
                      {' '}Dilution factor is calculated automatically.
                    </CardDescription>
                  </div>
                  {weightData?.found && weightData.dilution_rows.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      From Excel
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {/* Dilution row selector — only when multiple rows available */}
                {weightData?.found && weightData.dilution_rows.length > 1 && (
                  <div className="space-y-1">
                    <Label className="text-xs">Standard Concentration</Label>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
                      onChange={e => {
                        const idx = parseInt(e.target.value)
                        const row = weightData.dilution_rows[idx]
                        if (row) {
                          setWeights(prev => ({
                            ...prev,
                            dil_vial_empty: row.dil_vial_empty,
                            dil_vial_with_diluent: row.dil_vial_with_diluent,
                            dil_vial_with_diluent_and_sample: row.dil_vial_with_diluent_and_sample,
                          }))
                        }
                      }}
                    >
                      {weightData.dilution_rows.map((row, i) => (
                        <option key={i} value={i}>
                          {row.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <WeightsForm
                  weights={weights}
                  diluentDensity={selectedPeptide?.diluent_density ?? 997.1}
                  onChange={setWeights}
                />
              </CardContent>
            </Card>

            <div className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setStep('parse')}
                className="gap-2"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Parse
              </Button>
              <Button
                onClick={handleAnalyze}
                disabled={!canRunAnalysis || analyzing}
                className="gap-2"
              >
                {analyzing && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {analyzing ? 'Analyzing...' : 'Run Analysis'}
                {!analyzing && <ArrowRight className="h-4 w-4" />}
              </Button>
            </div>
          </>
        )}

        {/* STEP 3: Results */}
        {step === 'results' && analysisResult && (
          <>
            <AnalysisResults result={analysisResult} chromatograms={chromatograms} />
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleReset}>
                New Analysis
              </Button>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  )
}

function StepDot({
  active,
  done,
  label,
}: {
  active: boolean
  done: boolean
  label: string
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        active
          ? 'bg-primary text-primary-foreground'
          : done
            ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
            : 'bg-muted text-muted-foreground'
      }`}
    >
      {label}
    </span>
  )
}
