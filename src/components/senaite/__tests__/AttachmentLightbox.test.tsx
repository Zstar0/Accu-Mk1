import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import {
  AttachmentLightbox,
  ZoomableImage,
  formatBytes,
  parseUtcDate,
  parseAssignedVialFilename,
} from '@/components/senaite/AttachmentLightbox'

const noop = () => undefined

describe('formatBytes', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('parseUtcDate', () => {
  it('treats naive backend timestamps as UTC, not local time', () => {
    const d = parseUtcDate('2026-07-13T04:42:21')
    expect(d?.toISOString().startsWith('2026-07-13T04:42:21')).toBe(true)
  })

  it('leaves zone-suffixed timestamps alone', () => {
    const d = parseUtcDate('2026-07-13T04:42:21Z')
    expect(d?.toISOString().startsWith('2026-07-13T04:42:21')).toBe(true)
  })

  it('returns null for missing or invalid input', () => {
    expect(parseUtcDate(null)).toBeNull()
    expect(parseUtcDate(undefined)).toBeNull()
    expect(parseUtcDate('not-a-date')).toBeNull()
  })
})

describe('parseAssignedVialFilename', () => {
  it('extracts the source vial from Select Vial Image snapshot filenames', () => {
    expect(parseAssignedVialFilename('PB-0075-S03-vial-photo.jpg')).toBe(
      'PB-0075-S03'
    )
    expect(parseAssignedVialFilename('BW-0012-S11-vial-photo.webp')).toBe(
      'BW-0012-S11'
    )
  })

  it('returns null for filenames that are not vial snapshots', () => {
    expect(parseAssignedVialFilename('random.jpg')).toBeNull()
    expect(parseAssignedVialFilename('foo-vial-photo.jpg')).toBeNull()
    expect(parseAssignedVialFilename(null)).toBeNull()
    expect(parseAssignedVialFilename(undefined)).toBeNull()
  })
})

describe('AttachmentLightbox', () => {
  it('renders filename, badge, type, size and dates when provided', () => {
    render(
      <AttachmentLightbox
        open
        onOpenChange={noop}
        src="data:image/png;base64,"
        meta={{
          filename: 'PB-0075-S03-vial-photo.jpg',
          badge: 'Sample Image',
          contentType: 'image/jpeg',
          sizeBytes: 2048,
          takenAt: '2026-07-13T04:42:21',
        }}
      />
    )
    // Filename appears twice: sr-only dialog title + visible footer
    expect(
      screen.getAllByText('PB-0075-S03-vial-photo.jpg').length
    ).toBeGreaterThan(0)
    expect(screen.getByText('Sample Image')).toBeInTheDocument()
    expect(screen.getByText('image/jpeg')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    const expected = parseUtcDate('2026-07-13T04:42:21')?.toLocaleString() ?? ''
    expect(screen.getByText(`Taken ${expected}`)).toBeInTheDocument()
  })

  it('shows the source vial even without an assigned timestamp', () => {
    render(
      <AttachmentLightbox
        open
        onOpenChange={noop}
        src="data:image/png;base64,"
        meta={{
          filename: 'PB-0075-S03-vial-photo.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 100,
          sourceVialId: 'PB-0075-S03',
        }}
      />
    )
    expect(screen.getByText(/Assigned · from PB-0075-S03/)).toBeInTheDocument()
  })

  it('honors a custom takenAt label', () => {
    render(
      <AttachmentLightbox
        open
        onOpenChange={noop}
        src="data:image/png;base64,"
        meta={{
          filename: 'vial photo',
          contentType: 'image/png',
          sizeBytes: 100,
          takenAt: '2026-07-13T05:02:40Z',
          takenAtLabel: 'Received',
        }}
      />
    )
    const expected =
      parseUtcDate('2026-07-13T05:02:40Z')?.toLocaleString() ?? ''
    expect(screen.getByText(`Received ${expected}`)).toBeInTheDocument()
  })
})

describe('ZoomableImage', () => {
  it('opens the lightbox when the thumbnail is clicked', () => {
    render(
      <ZoomableImage
        src="data:image/png;base64,"
        alt="P-1 packaging"
        meta={{
          badge: 'Packaging',
          contentType: 'image/png',
          sizeBytes: 100,
        }}
      />
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /P-1 packaging/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Packaging')).toBeInTheDocument()
  })
})
