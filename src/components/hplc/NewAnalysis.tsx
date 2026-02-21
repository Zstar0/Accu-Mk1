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
  Cloud,
  Search,
  Star,
  Eye,
  FlaskConical,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { PeakTable } from './PeakTable'
import { PeptideSelector } from './PeptideSelector'
import { WeightsForm } from './WeightsForm'
import { AnalysisResults } from './AnalysisResults'
import { CalibrationChart } from './CalibrationChart'
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
  downloadSharePointFiles,
  getCalibrations,
  type HPLCParseResult,
  type HPLCWeightsInput,
  type HPLCAnalysisResult,
  type PeptideRecord,
  type CalibrationCurve,
  type WeightExtractionResult,
  type SharePointItem,
} from '@/lib/api'
import { SharePointBrowser } from './SharePointBrowser'

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
  const [_scanProgress, setScanProgress] = useState<{
    total: number
    processed: number
    filesFound: number
  } | null>(null)
  const [chromatograms, setChromatograms] = useState<ChromatogramTrace[]>([])

  // Blend state: which peptide from a blend is being analyzed
  const [selectedBlendPeptide, setSelectedBlendPeptide] = useState<string | null>(null)
  const isBlend = (parseResult?.detected_peptides?.length ?? 0) > 1
  const blendPeptides = parseResult?.detected_peptides ?? []

  // Filtered injections for current blend peptide (or all if not a blend)
  const activeInjections = isBlend && selectedBlendPeptide
    ? parseResult?.injections.filter(inj => inj.peptide_label === selectedBlendPeptide) ?? []
    : parseResult?.injections ?? []

  // Step 2: Configure
  const [sampleId, setSampleId] = useState('')
  const [selectedPeptide, setSelectedPeptide] = useState<PeptideRecord | null>(
    null
  )
  const [weights, setWeights] = useState<HPLCWeightsInput>(EMPTY_WEIGHTS)
  const [weightData, setWeightData] = useState<WeightExtractionResult | null>(null)
  const [weightsFetched, setWeightsFetched] = useState(false)
  const [weightsLoading, setWeightsLoading] = useState(false)

  // Instrument & curve selection
  const [allCalibrations, setAllCalibrations] = useState<CalibrationCurve[]>([])
  const [selectedInstrument, setSelectedInstrument] = useState<string>('1290')
  const [selectedCurve, setSelectedCurve] = useState<CalibrationCurve | null>(null)
  const [calibrationsLoading, setCalibrationsLoading] = useState(false)

  // SharePoint state
  const [spLoading, setSpLoading] = useState(false)
  const [spFolderName, setSpFolderName] = useState<string | null>(null)

  // Step 3: Results
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisResult, setAnalysisResult] =
    useState<HPLCAnalysisResult | null>(null)

  // Fetch calibrations when peptide changes
  useEffect(() => {
    if (!selectedPeptide) {
      setAllCalibrations([])
      setSelectedCurve(null)
      return
    }
    setCalibrationsLoading(true)
    getCalibrations(selectedPeptide.id)
      .then(cals => {
        setAllCalibrations(cals)
        // Auto-select the active curve for the current instrument
        const activeCurve = cals.find(
          c => c.is_active && (c.instrument ?? 'unknown') === selectedInstrument
        )
        if (activeCurve) {
          setSelectedCurve(activeCurve)
        } else {
          // Fall back to any active curve
          const anyActive = cals.find(c => c.is_active)
          if (anyActive) {
            setSelectedCurve(anyActive)
            setSelectedInstrument(anyActive.instrument ?? 'unknown')
          } else {
            setSelectedCurve(null)
          }
        }
      })
      .catch(() => {
        setAllCalibrations([])
        setSelectedCurve(null)
      })
      .finally(() => setCalibrationsLoading(false))
  }, [selectedPeptide?.id])

  // When instrument changes, auto-select the active curve for that instrument
  useEffect(() => {
    if (allCalibrations.length === 0) return
    const activeCurve = allCalibrations.find(
      c => c.is_active && (c.instrument ?? 'unknown') === selectedInstrument
    )
    if (activeCurve) {
      setSelectedCurve(activeCurve)
    } else {
      // Fall back to most recent curve for this instrument
      const instrCals = allCalibrations.filter(
        c => (c.instrument ?? 'unknown') === selectedInstrument
      )
      setSelectedCurve(instrCals[0] ?? null)
    }
  }, [selectedInstrument, allCalibrations])

  // Helper: populate weight fields from an analyte's data
  const applyAnalyteWeights = useCallback((analyte: { stock_vial_empty: number | null, stock_vial_with_diluent: number | null, dilution_rows: { dil_vial_empty: number, dil_vial_with_diluent: number, dil_vial_with_diluent_and_sample: number }[] }) => {
    if (analyte.dilution_rows.length > 0) {
      const firstDil = analyte.dilution_rows[0]!
      setWeights({
        stock_vial_empty: analyte.stock_vial_empty ?? 0,
        stock_vial_with_diluent: analyte.stock_vial_with_diluent ?? 0,
        dil_vial_empty: firstDil.dil_vial_empty,
        dil_vial_with_diluent: firstDil.dil_vial_with_diluent,
        dil_vial_with_diluent_and_sample: firstDil.dil_vial_with_diluent_and_sample,
      })
    }
  }, [])

  // Auto-fetch weights from SharePoint when entering configure step
  useEffect(() => {
    if (step !== 'configure' || !sampleId || weightsFetched) return
    setWeightsFetched(true)
    setWeightsLoading(true)

    fetchSampleWeights(sampleId)
      .then(data => {
        setWeightData(data)
        // For blends with per-analyte sheets, pick the matching analyte
        if (data.found && data.analytes.length > 1 && selectedBlendPeptide) {
          const blendLabel = selectedBlendPeptide.toLowerCase().replace(/[-\s]/g, '')
          const match = data.analytes.find(a =>
            a.sheet_name.toLowerCase().replace(/[-\s]/g, '').includes(blendLabel) ||
            blendLabel.includes(a.sheet_name.toLowerCase().replace(/[-\s]/g, ''))
          )
          if (match) {
            applyAnalyteWeights(match)
            return
          }
        }
        // Non-blend or no match: use top-level weights
        if (data.found && data.dilution_rows.length > 0) {
          applyAnalyteWeights(data)
        }
      })
      .catch(() => {
        // Silent fail — user can still enter manually
      })
      .finally(() => setWeightsLoading(false))
  }, [step, sampleId, weightsFetched, selectedBlendPeptide, applyAnalyteWeights])

  // When blend peptide changes, re-apply weights from the matching analyte sheet
  useEffect(() => {
    if (!weightData || !selectedBlendPeptide || weightData.analytes.length <= 1) return
    const blendLabel = selectedBlendPeptide.toLowerCase().replace(/[-\s]/g, '')
    const match = weightData.analytes.find(a =>
      a.sheet_name.toLowerCase().replace(/[-\s]/g, '').includes(blendLabel) ||
      blendLabel.includes(a.sheet_name.toLowerCase().replace(/[-\s]/g, ''))
    )
    if (match) {
      applyAnalyteWeights(match)
    }
  }, [selectedBlendPeptide, weightData, applyAnalyteWeights])

  // --- Helpers ---
  const extractSampleId = (filename: string): string | null => {
    // Match P-XXXX or PB-XXXX pattern from filenames
    // e.g. "P-0142_Inj_1_PeakData.csv" or "PB-0053_Inj_1_BPC_PeakData.csv"
    const match = filename.match(/^(PB?-\d+)/i)
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

    // For blends, only send the selected peptide's injections
    const injToSend = isBlend && selectedBlendPeptide
      ? parseResult.injections.filter(inj => inj.peptide_label === selectedBlendPeptide)
      : parseResult.injections

    try {
      const result = await runHPLCAnalysis({
        sample_id_label: sampleId.trim() || 'Unknown',
        peptide_id: selectedPeptide.id,
        calibration_curve_id: selectedCurve?.id,
        weights,
        injections: injToSend as unknown as Record<
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
  }, [parseResult, selectedPeptide, selectedCurve, sampleId, weights, isBlend, selectedBlendPeptide])

  const handleReset = useCallback(() => {
    setStep('parse')
    setFiles([])
    setParseResult(null)
    setError(null)
    setScanProgress(null)
    setChromatograms([])
    setSampleId('')
    setSelectedPeptide(null)
    setSelectedBlendPeptide(null)
    setWeights(EMPTY_WEIGHTS)
    setWeightData(null)
    setWeightsFetched(false)
    setAnalysisResult(null)
    setSpFolderName(null)
    setAllCalibrations([])
    setSelectedInstrument('1290')
    setSelectedCurve(null)
  }, [])

  // --- SharePoint folder selection handler ---
  const handleSharePointFolder = useCallback(
    async (_path: string, folderName: string, items: SharePointItem[]) => {
      setSpLoading(true)
      setError(null)
      setSpFolderName(folderName)

      try {
        // Filter CSV file IDs from the selected folder
        const csvItems = items.filter(
          i => i.type === 'file' && i.name.toLowerCase().endsWith('.csv')
        )

        if (csvItems.length === 0) {
          setError('No CSV files found in the selected folder.')
          setSpLoading(false)
          return
        }

        // Download all CSVs in one batch request
        const downloaded = await downloadSharePointFiles(
          csvItems.map(i => i.id)
        )

        // Separate PeakData from chromatogram files
        const peakFiles: FileEntry[] = []
        const chromTraces: ChromatogramTrace[] = []

        for (const dl of downloaded) {
          const lower = dl.filename.toLowerCase()
          if (lower.includes('peakdata') && lower.endsWith('.csv')) {
            // Create a File-like object for the existing parse pipeline
            const blob = new Blob([dl.content], { type: 'text/csv' })
            const file = new File([blob], dl.filename, { type: 'text/csv' })
            peakFiles.push({ file, name: dl.filename })
          } else if (lower.includes('dx_dad1a') && lower.endsWith('.csv')) {
            // Parse chromatogram data
            const raw = parseChromatogramCsv(dl.content)
            if (raw.length > 0) {
              const points = downsampleLTTB(raw, 1500)
              const injMatch = dl.filename.match(/Inj[_\s]*(\d+)/i)
              const name = injMatch
                ? `Inj ${injMatch[1]}`
                : dl.filename.replace(/\.csv$/i, '')
              chromTraces.push({ name, points })
            }
          }
        }

        if (peakFiles.length === 0) {
          setError('No PeakData CSV files found in the downloaded files.')
          setSpLoading(false)
          return
        }

        // Sort chromatogram traces
        chromTraces.sort((a, b) => a.name.localeCompare(b.name))
        setChromatograms(chromTraces)

        // Auto-detect sample ID from folder name or filename
        if (!sampleId) {
          let detectedId = extractSampleId(folderName)
          if (!detectedId) {
            for (const f of peakFiles) {
              detectedId = extractSampleId(f.name)
              if (detectedId) break
            }
          }
          if (detectedId) setSampleId(detectedId)
        }

        // Set files and clear any old parse result
        setFiles(peakFiles)
        setParseResult(null)
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to load SharePoint files'
        )
      } finally {
        setSpLoading(false)
      }
    },
    [sampleId]
  )

  const canProceedToConfigure =
    parseResult !== null && parseResult.injections.length > 0
  const canRunAnalysis =
    selectedPeptide !== null &&
    selectedCurve !== null &&
    weights.stock_vial_empty > 0 &&
    weights.dil_vial_with_diluent_and_sample > 0 &&
    (!isBlend || selectedBlendPeptide !== null)

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 p-6">
        {/* Header with sample ID and step indicator */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">Import Analysis</h1>
              {sampleId && (
                <Badge variant="outline" className="text-base font-mono font-semibold px-3 py-0.5 border-primary/40">
                  {sampleId}
                </Badge>
              )}
              {isBlend && selectedBlendPeptide && step !== 'parse' && (
                <Badge className="bg-purple-600 text-white text-xs">
                  <FlaskConical className="h-3 w-3 mr-1" />
                  {selectedBlendPeptide}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1 text-sm">
              <StepDot active={step === 'parse'} done={step !== 'parse'} label="1. Parse" />
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <StepDot active={step === 'configure'} done={step === 'results'} label="2. Configure" />
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <StepDot active={step === 'results'} done={false} label="3. Results" />
            </div>
          </div>
          <p className="text-muted-foreground">
            {step === 'parse' && 'Step 1: Select a sample folder from SharePoint and parse peaks.'}
            {step === 'configure' && 'Step 2: Select peptide and enter sample weights.'}
            {step === 'results' && 'Step 3: Analysis complete.'}
          </p>
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
            {/* SharePoint Browser */}
            <SharePointBrowser
              onFolderSelected={handleSharePointFolder}
              disabled={spLoading || parsing}
            />

            {/* Loading state for SharePoint download */}
            {spLoading && (
              <Card>
                <CardContent className="flex items-center gap-3 py-6">
                  <Loader2 className="h-5 w-5 animate-spin text-blue-500" />
                  <div>
                    <p className="text-sm font-medium">Downloading files from SharePoint...</p>
                    <p className="text-xs text-muted-foreground">
                      Fetching CSVs from {spFolderName || 'selected folder'}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Downloaded files + parse controls */}
            {files.length > 0 && !spLoading && (
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-2">
                    {spFolderName ? (
                      <Cloud className="h-4 w-4 text-blue-500" />
                    ) : (
                      <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    )}
                    <CardTitle className="text-base">
                      {spFolderName
                        ? `Files from: ${spFolderName}`
                        : 'PeakData Files'}
                    </CardTitle>
                  </div>
                  <CardDescription>
                    {files.length} PeakData CSV{files.length !== 1 ? 's' : ''}
                    {chromatograms.length > 0 &&
                      ` + ${chromatograms.length} chromatogram${chromatograms.length !== 1 ? 's' : ''}`}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2 max-h-[200px] overflow-auto">
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
                    <Button variant="outline" onClick={handleReset}>
                      Clear
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Fallback: drag-and-drop for local files */}
            {files.length === 0 && !spLoading && (
              <Card className="border-muted">
                <CardContent className="pt-4">
                  <div
                    onDrop={handleDrop}
                    onDragOver={e => e.preventDefault()}
                    className="flex min-h-[80px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-muted-foreground/15 bg-muted/30 p-4 transition-colors hover:border-primary/30 hover:bg-muted/50"
                    onClick={() =>
                      document.getElementById('hplc-file-input')?.click()
                    }
                  >
                    <div className="flex items-center gap-2 text-muted-foreground/40">
                      <Upload className="h-5 w-5" />
                    </div>
                    <p className="text-xs text-muted-foreground/60">
                      Or drop local CSV files / folders here
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
                </CardContent>
              </Card>
            )}

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
                {/* Blend detection banner */}
                {isBlend && (
                  <Card className="border-purple-500/50 bg-purple-500/5">
                    <CardContent className="flex items-center gap-3 py-3">
                      <div className="flex items-center justify-center h-8 w-8 rounded-full bg-purple-500/10">
                        <FlaskConical className="h-4 w-4 text-purple-500" />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-purple-700 dark:text-purple-400">
                          Blend Detected — {blendPeptides.length} peptides
                        </p>
                        <div className="flex gap-1.5 mt-1">
                          {blendPeptides.map(label => (
                            <Badge key={label} variant="outline" className="text-xs border-purple-500/30">
                              {label}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground max-w-48">
                        Each peptide will be analyzed separately in Step 2.
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* Purity preview — per-peptide for blends */}
                {isBlend ? (
                  <Card>
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                        <CardTitle className="text-base">
                          Purity (preview per peptide)
                        </CardTitle>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-6">
                        {blendPeptides.map(label => {
                          const pepInjs = parseResult.injections.filter(
                            inj => inj.peptide_label === label
                          )
                          const values = pepInjs
                            .filter(inj => inj.main_peak_index >= 0)
                            .map(inj => inj.peaks[inj.main_peak_index]!.area_percent)
                          const avg = values.length > 0
                            ? values.reduce((a, b) => a + b, 0) / values.length
                            : null
                          return (
                            <div key={label} className="flex flex-col gap-1">
                              <Badge variant="outline" className="w-fit text-xs border-purple-500/30 mb-1">
                                {label}
                              </Badge>
                              <div className="flex items-baseline gap-1">
                                <span className="text-2xl font-bold tabular-nums">
                                  {avg != null ? avg.toFixed(2) : '—'}
                                </span>
                                <span className="text-lg text-muted-foreground">%</span>
                              </div>
                              <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                                {values.map((val, i) => (
                                  <span key={i} className="font-mono">{pepInjs[i]?.injection_name}: {val.toFixed(4)}%</span>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </CardContent>
                  </Card>
                ) : (
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
                )}

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
                    onClick={() => {
                      // Auto-select first blend peptide when transitioning
                      if (isBlend && !selectedBlendPeptide && blendPeptides.length > 0) {
                        setSelectedBlendPeptide(blendPeptides[0]!)
                      }
                      setStep('configure')
                    }}
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
            {/* Blend peptide selector */}
            {isBlend && (
              <Card className="border-purple-500/50">
                <CardContent className="flex items-center gap-4 py-3">
                  <div className="flex items-center gap-2">
                    <FlaskConical className="h-4 w-4 text-purple-500" />
                    <span className="text-sm font-medium">Analyzing peptide:</span>
                  </div>
                  <div className="flex gap-1.5">
                    {blendPeptides.map(label => (
                      <Button
                        key={label}
                        size="sm"
                        variant={selectedBlendPeptide === label ? 'default' : 'outline'}
                        className={selectedBlendPeptide === label
                          ? 'bg-purple-600 hover:bg-purple-700 text-white'
                          : 'border-purple-500/30 text-purple-700 dark:text-purple-400'
                        }
                        onClick={() => {
                          setSelectedBlendPeptide(label)
                          // Reset peptide/curve selection for new blend peptide
                          setSelectedPeptide(null)
                          setSelectedCurve(null)
                          setAllCalibrations([])
                        }}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                  {selectedBlendPeptide && (
                    <span className="text-xs text-muted-foreground ml-auto">
                      {activeInjections.length} injection{activeInjections.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </CardContent>
              </Card>
            )}

            {/* SharePoint search status banner */}
            {weightsLoading && (
              <Card className="border-blue-500/50 bg-blue-500/5">
                <CardContent className="flex items-center gap-3 py-3">
                  <div className="relative flex items-center justify-center h-8 w-8">
                    <div className="absolute inset-0 rounded-full border-2 border-blue-500/20" />
                    <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-blue-500 animate-spin" />
                    <Search className="h-3.5 w-3.5 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">Searching SharePoint...</p>
                    <p className="text-xs text-muted-foreground">
                      Looking for sample <span className="font-mono">{sampleId}</span> in Peptides folder
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {!weightsLoading && weightData && (
              <Card className={weightData.found && weightData.dilution_rows.length > 0
                ? 'border-green-500/50 bg-green-500/5'
                : 'border-yellow-500/50 bg-yellow-500/5'
              }>
                <CardContent className="flex items-center gap-3 py-3">
                  <div className={`flex items-center justify-center h-8 w-8 rounded-full ${
                    weightData.found && weightData.dilution_rows.length > 0
                      ? 'bg-green-500/10'
                      : 'bg-yellow-500/10'
                  }`}>
                    {weightData.found && weightData.dilution_rows.length > 0 ? (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-yellow-500" />
                    )}
                  </div>
                  <div className="flex-1">
                    {weightData.found && weightData.dilution_rows.length > 0 ? (
                      <>
                        <p className="text-sm font-medium text-green-700 dark:text-green-400">
                          Found sample in <span className="font-mono">{weightData.peptide_folder}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {weightData.analytes.length > 1
                            ? `${weightData.analytes.length} analyte sheets in ${weightData.excel_filename}`
                            : `Auto-loaded from ${weightData.excel_filename}`
                          }
                          {weightData.analytes.length > 1 && selectedBlendPeptide && (() => {
                            const blendLabel = selectedBlendPeptide.toLowerCase().replace(/[-\s]/g, '')
                            const match = weightData.analytes.find(a =>
                              a.sheet_name.toLowerCase().replace(/[-\s]/g, '').includes(blendLabel) ||
                              blendLabel.includes(a.sheet_name.toLowerCase().replace(/[-\s]/g, ''))
                            )
                            return match
                              ? ` — using sheet "${match.sheet_name}"`
                              : ''
                          })()}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                          {weightData.found ? 'No weight data found' : 'Sample not found on SharePoint'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {weightData.error || 'Enter weights manually below'}
                        </p>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

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
                  autoSelectLabel={selectedBlendPeptide}
                />
                {/* Instrument & Curve Selection */}
                {selectedPeptide && (
                  <CurveSelector
                    allCalibrations={allCalibrations}
                    selectedInstrument={selectedInstrument}
                    selectedCurve={selectedCurve}
                    loading={calibrationsLoading}
                    onInstrumentChange={setSelectedInstrument}
                    onCurveChange={setSelectedCurve}
                    matchingCurveIds={weightData?.tech_calibration?.matching_curve_ids ?? []}
                  />
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
                    <Select
                      defaultValue="0"
                      onValueChange={val => {
                        const idx = parseInt(val)
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
                      <SelectTrigger className="font-mono">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {weightData.dilution_rows.map((row, i) => (
                          <SelectItem key={i} value={String(i)} className="font-mono">
                            {row.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
              {/* For blends, offer to analyze next peptide */}
              {isBlend && (() => {
                const currentIdx = blendPeptides.indexOf(selectedBlendPeptide ?? '')
                const nextLabel = currentIdx >= 0 && currentIdx < blendPeptides.length - 1
                  ? blendPeptides[currentIdx + 1]
                  : null
                return nextLabel ? (
                  <Button
                    onClick={() => {
                      setSelectedBlendPeptide(nextLabel)
                      setSelectedPeptide(null)
                      setSelectedCurve(null)
                      setAllCalibrations([])
                      setAnalysisResult(null)
                      setStep('configure')
                    }}
                    className="gap-2 bg-purple-600 hover:bg-purple-700"
                  >
                    <FlaskConical className="h-4 w-4" />
                    Analyze {nextLabel}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : null
              })()}
              <Button variant="outline" onClick={handleReset}>
                Import Another
              </Button>
            </div>
          </>
        )}
      </div>
    </ScrollArea>
  )
}

function CurveSelector({
  allCalibrations,
  selectedInstrument,
  selectedCurve,
  loading,
  onInstrumentChange,
  onCurveChange,
  matchingCurveIds = [],
}: {
  allCalibrations: CalibrationCurve[]
  selectedInstrument: string
  selectedCurve: CalibrationCurve | null
  loading: boolean
  onInstrumentChange: (inst: string) => void
  onCurveChange: (curve: CalibrationCurve | null) => void
  matchingCurveIds?: number[]
}) {
  const instrumentOrder = ['1290', '1260', 'unknown']
  const instruments = instrumentOrder.filter(inst =>
    allCalibrations.some(c => (c.instrument ?? 'unknown') === inst)
  )

  const instrumentCals = allCalibrations.filter(
    c => (c.instrument ?? 'unknown') === selectedInstrument
  )

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading calibration curves...
      </div>
    )
  }

  if (allCalibrations.length === 0) {
    return (
      <p className="text-sm text-destructive">
        This peptide has no calibration curves. Add one in Peptide Standards first.
      </p>
    )
  }

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })

  return (
    <div className="flex flex-col gap-3">
      {/* Instrument selector */}
      {instruments.length > 1 && (
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground shrink-0">Instrument</Label>
          <div className="flex items-center gap-1">
            {instruments.map(inst => (
              <button
                key={inst}
                onClick={() => onInstrumentChange(inst)}
                className={`px-2.5 py-1 rounded text-xs font-mono border transition-colors ${
                  selectedInstrument === inst
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40'
                }`}
              >
                {inst}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Curve selector */}
      {instrumentCals.length === 0 ? (
        <p className="text-sm text-destructive">
          No calibration curves for instrument {selectedInstrument}.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {instrumentCals.map(cal => {
            const isSelected = selectedCurve?.id === cal.id
            const displayDate = cal.source_date || cal.created_at
            const isTechMatch = matchingCurveIds.includes(cal.id)
            return (
              <button
                key={cal.id}
                onClick={() => onCurveChange(cal)}
                className={`flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                  isSelected
                    ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
                    : 'border-border bg-card hover:bg-accent/50'
                }`}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {cal.is_active && (
                    <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500 shrink-0" />
                  )}
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-2">
                      {cal.is_active && (
                        <Badge variant="default" className="text-[10px] px-1.5 py-0">
                          Active
                        </Badge>
                      )}
                      {isTechMatch && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-emerald-500/50 text-emerald-500">
                          Tech Match
                        </Badge>
                      )}
                      <span className="font-mono text-sm truncate">
                        y = {cal.slope.toFixed(4)}x + {cal.intercept.toFixed(4)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>R² = {cal.r_squared.toFixed(6)}</span>
                      <span>•</span>
                      <span>{formatDate(displayDate)}</span>
                      {cal.source_filename && (
                        <>
                          <span>•</span>
                          <span className="truncate">{cal.source_filename}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Preview button */}
                {cal.standard_data && cal.standard_data.concentrations.length > 0 && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 shrink-0"
                        onClick={e => e.stopPropagation()}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent side="left" align="center" className="w-[400px] p-3 max-h-[480px] overflow-auto">
                      <div className="flex flex-col gap-3">
                        <p className="text-xs font-medium text-muted-foreground">
                          Calibration Curve Preview
                        </p>
                        <CalibrationChart
                          concentrations={cal.standard_data.concentrations}
                          areas={cal.standard_data.areas}
                          slope={cal.slope}
                          intercept={cal.intercept}
                        />
                        <div className="text-xs font-mono text-center text-muted-foreground">
                          y = {cal.slope.toFixed(4)}x + {cal.intercept.toFixed(4)} • R² = {cal.r_squared.toFixed(6)}
                        </div>
                        {/* Standard data table */}
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="py-1 text-left font-medium w-8">#</th>
                              <th className="py-1 text-right font-medium">Conc (µg/mL)</th>
                              <th className="py-1 text-right font-medium">Area</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cal.standard_data.concentrations.map((conc, i) => (
                              <tr key={i} className="border-b border-border/50">
                                <td className="py-1 font-mono text-muted-foreground">{i + 1}</td>
                                <td className="py-1 text-right font-mono">{conc.toFixed(2)}</td>
                                <td className="py-1 text-right font-mono">
                                  {cal.standard_data!.areas[i] != null
                                    ? cal.standard_data!.areas[i].toFixed(3)
                                    : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </PopoverContent>
                  </Popover>
                )}

                {/* Selection indicator */}
                {isSelected && (
                  <div className="h-2 w-2 rounded-full bg-primary shrink-0" />
                )}
              </button>
            )
          })}
        </div>
      )}

      {/* Selected curve summary */}
      {selectedCurve && (
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <p className="font-mono">
            Area = {selectedCurve.slope.toFixed(4)} × Conc +{' '}
            {selectedCurve.intercept.toFixed(4)}
          </p>
          <p className="text-xs text-muted-foreground">
            R² = {selectedCurve.r_squared.toFixed(6)}
            {selectedCurve.instrument && (
              <span> • Instrument: {selectedCurve.instrument}</span>
            )}
          </p>
        </div>
      )}
    </div>
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
