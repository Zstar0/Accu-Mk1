import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sheet, SheetTitle } from '@/components/ui/sheet'
import { ResizableSheetContent } from './ResizableSheetContent'

const KEY = 'mk1.customerSlideoutWidth'

function setup() {
  render(
    <Sheet open>
      <ResizableSheetContent>
        <SheetTitle>Panel</SheetTitle>
      </ResizableSheetContent>
    </Sheet>
  )
  return {
    dialog: screen.getByRole('dialog'),
    handle: screen.getByRole('separator', { name: 'Resize panel' }),
  }
}

describe('ResizableSheetContent', () => {
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1024
  })
  afterEach(() => vi.restoreAllMocks())

  it('defaults to 576 when storage is empty', () => {
    const { dialog, handle } = setup()
    expect(dialog.style.width).toBe('576px')
    expect(dialog.style.maxWidth).toBe('none')
    expect(handle).toHaveAttribute('aria-valuenow', '576')
    expect(handle).toHaveAttribute('aria-valuemin', '400')
    expect(handle).toHaveAttribute('aria-valuemax', '922')
  })

  it('restores a stored width', () => {
    localStorage.setItem(KEY, '700')
    expect(setup().dialog.style.width).toBe('700px')
  })

  it('clamps stored widths outside min/max', () => {
    localStorage.setItem(KEY, '100')
    expect(setup().dialog.style.width).toBe('400px')
  })

  it('clamps a too-large stored width to 90% of the window', () => {
    localStorage.setItem(KEY, '5000')
    expect(setup().dialog.style.width).toBe('921.6px')
  })

  it('ArrowLeft widens, ArrowRight narrows, and both persist', () => {
    const { dialog, handle } = setup()
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(dialog.style.width).toBe('608px')
    expect(localStorage.getItem(KEY)).toBe('608')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(dialog.style.width).toBe('544px')
    expect(localStorage.getItem(KEY)).toBe('544')
  })

  it('double-click resets to the default and persists', () => {
    localStorage.setItem(KEY, '700')
    const { dialog, handle } = setup()
    fireEvent.doubleClick(handle)
    expect(dialog.style.width).toBe('576px')
    expect(localStorage.getItem(KEY)).toBe('576')
  })

  it('drag sets width from the pointer and persists on release only', () => {
    const { dialog, handle } = setup()
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 448 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 324 })
    expect(dialog.style.width).toBe('700px')
    expect(localStorage.getItem(KEY)).toBeNull()
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 324 })
    expect(localStorage.getItem(KEY)).toBe('700')
  })

  it('works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const { dialog, handle } = setup()
    expect(dialog.style.width).toBe('576px')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(dialog.style.width).toBe('608px')
  })

  it('ignores the stored width below 640px', () => {
    localStorage.setItem(KEY, '700')
    window.innerWidth = 500
    render(
      <Sheet open>
        <ResizableSheetContent>
          <SheetTitle>Panel</SheetTitle>
        </ResizableSheetContent>
      </Sheet>
    )
    expect(screen.getByRole('dialog').style.width).toBe('')
  })
})
