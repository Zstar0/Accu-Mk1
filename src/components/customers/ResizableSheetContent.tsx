import * as React from 'react'
import { SheetContent } from '@/components/ui/sheet'
import { SLIDEOUT_STEP, useSlideoutWidth } from './useSlideoutWidth'
import { cn } from '@/lib/utils'

/** Drop-in SheetContent with a draggable, keyboard-accessible left edge. */
export function ResizableSheetContent({
  className,
  style,
  children,
  ...props
}: React.ComponentProps<typeof SheetContent>) {
  const w = useSlideoutWidth()
  const dragging = React.useRef(false)

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') w.nudge(SLIDEOUT_STEP)
    else if (e.key === 'ArrowRight') w.nudge(-SLIDEOUT_STEP)
    else return
    e.preventDefault()
  }

  return (
    <SheetContent
      className={cn('w-full', className)}
      style={w.desktop ? { ...style, width: w.width, maxWidth: 'none' } : style}
      {...props}
    >
      {w.desktop && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panel"
          aria-valuenow={Math.round(w.width)}
          aria-valuemin={w.min}
          aria-valuemax={Math.round(w.max)}
          tabIndex={0}
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 focus-visible:outline-none"
          onPointerDown={e => {
            dragging.current = true
            e.currentTarget.setPointerCapture?.(e.pointerId)
          }}
          onPointerMove={e => {
            if (dragging.current) w.drag(window.innerWidth - e.clientX)
          }}
          onPointerUp={e => {
            if (!dragging.current) return
            dragging.current = false
            e.currentTarget.releasePointerCapture?.(e.pointerId)
            w.commit()
          }}
          onKeyDown={onKeyDown}
          onDoubleClick={w.reset}
        />
      )}
      {children}
    </SheetContent>
  )
}
