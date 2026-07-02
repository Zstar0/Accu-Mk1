import { describe, it, expect } from 'vitest'
import {
  classifyHplcFile,
  deriveFolderName,
  readLocalHplcFolder,
  localDownloadedFiles,
  localPeakNames,
  type LocalFileLike,
} from '../hplc-local-files'
import type { HplcScanMatch } from '@/lib/api'

// Fake File — only the fields the helpers read.
function f(name: string, content = '', dir = 'RunFolder'): LocalFileLike {
  return { name, webkitRelativePath: `${dir}/${name}`, text: async () => content }
}

describe('classifyHplcFile', () => {
  it('classifies PeakData as peak (case-insensitive)', () => {
    expect(classifyHplcFile('P-0416_Inj_1_Std_PeakData.csv')).toBe('peak')
    expect(classifyHplcFile('x_PEAKDATA.CSV')).toBe('peak')
  })
  it('classifies DAD1A traces as chrom (case-insensitive)', () => {
    expect(classifyHplcFile('P-0309_Std_250.dx_DAD1A.CSV')).toBe('chrom')
    expect(classifyHplcFile('a_dad1a.csv')).toBe('chrom')
  })
  it('ignores everything else', () => {
    expect(classifyHplcFile('notes.txt')).toBeNull()
    expect(classifyHplcFile('summary.csv')).toBeNull()
  })
})

describe('deriveFolderName', () => {
  it('uses the top-level dir of webkitRelativePath', () => {
    expect(deriveFolderName([f('a_PeakData.csv', '', 'Batch12')])).toBe('Batch12')
  })
  it('falls back when no relative path', () => {
    expect(deriveFolderName([{ name: 'a_PeakData.csv', text: async () => '' }])).toBe('Local folder')
  })
})

describe('readLocalHplcFolder', () => {
  it('reads + classifies only HPLC csvs, keeping content', async () => {
    const res = await readLocalHplcFolder([
      f('P1_PeakData.csv', 'peakbytes'),
      f('P1.dx_DAD1A.CSV', 'chrombytes'),
      f('readme.txt', 'nope'),
    ])
    expect(res.folderName).toBe('RunFolder')
    expect(res.localFiles).toEqual([
      { filename: 'P1_PeakData.csv', content: 'peakbytes', kind: 'peak' },
      { filename: 'P1.dx_DAD1A.CSV', content: 'chrombytes', kind: 'chrom' },
    ])
  })
})

describe('local resolution helpers', () => {
  const local: HplcScanMatch = {
    prep_id: 1, senaite_sample_id: 'P-1', folder_name: 'F', folder_id: '',
    peak_files: [], chrom_files: [], is_override: true, source: 'local',
    local_files: [
      { filename: 'a_PeakData.csv', content: 'x', kind: 'peak' },
      { filename: 'b_PeakData.csv', content: 'y', kind: 'peak' },
      { filename: 'c.dx_DAD1A.CSV', content: 'z', kind: 'chrom' },
    ],
  }
  it('localDownloadedFiles mirrors downloadSharePointFiles shape', () => {
    expect(localDownloadedFiles(local)).toEqual([
      { filename: 'a_PeakData.csv', content: 'x' },
      { filename: 'b_PeakData.csv', content: 'y' },
      { filename: 'c.dx_DAD1A.CSV', content: 'z' },
    ])
  })
  it('localPeakNames returns only peak filenames', () => {
    expect(localPeakNames(local)).toEqual(new Set(['a_PeakData.csv', 'b_PeakData.csv']))
  })
})
