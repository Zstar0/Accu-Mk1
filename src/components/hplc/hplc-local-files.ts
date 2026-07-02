/**
 * Pure helpers for the "Local files" HPLC source. Classification mirrors the
 * backend SharePoint folder match: peak = *_PeakData.csv, chrom = *_DAD1A.csv.
 */
import type { HplcScanMatch, LocalHplcFile } from '@/lib/api'

const PEAK_RE = /_PeakData\.csv$/i
const CHROM_RE = /_DAD1A\.csv$/i

export function classifyHplcFile(name: string): 'peak' | 'chrom' | null {
  if (PEAK_RE.test(name)) return 'peak'
  if (CHROM_RE.test(name)) return 'chrom'
  return null
}

/** File-like shape the read path needs (real DOM File satisfies this). */
export interface LocalFileLike {
  name: string
  webkitRelativePath?: string
  text(): Promise<string>
}

export function deriveFolderName(files: LocalFileLike[]): string {
  for (const f of files) {
    const rel = f.webkitRelativePath
    if (rel?.includes('/')) return rel.split('/')[0]!
  }
  return 'Local folder'
}

export async function readLocalHplcFolder(
  files: LocalFileLike[],
): Promise<{ folderName: string; localFiles: LocalHplcFile[] }> {
  const folderName = deriveFolderName(files)
  const localFiles: LocalHplcFile[] = []
  for (const f of files) {
    const kind = classifyHplcFile(f.name)
    if (!kind) continue
    const content = await f.text()
    localFiles.push({ filename: f.name, content, kind })
  }
  return { folderName, localFiles }
}

/** {filename, content}[] for a local match — same shape downloadSharePointFiles returns. */
export function localDownloadedFiles(
  match: HplcScanMatch,
): { filename: string; content: string }[] {
  return (match.local_files ?? []).map(f => ({ filename: f.filename, content: f.content }))
}

export function localPeakNames(match: HplcScanMatch): Set<string> {
  return new Set(
    (match.local_files ?? []).filter(f => f.kind === 'peak').map(f => f.filename),
  )
}
