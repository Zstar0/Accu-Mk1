import { cn } from '@/lib/utils'
import type { HPLCPeak } from '@/lib/api'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

interface PeakTableProps {
  peaks: HPLCPeak[]
  totalArea: number
}

export function PeakTable({ peaks, totalArea }: PeakTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead className="text-right">RT (min)</TableHead>
          <TableHead className="text-right">Height</TableHead>
          <TableHead className="text-right">Area</TableHead>
          <TableHead className="text-right">Area %</TableHead>
          <TableHead className="text-right">Begin</TableHead>
          <TableHead className="text-right">End</TableHead>
          <TableHead className="w-24"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {peaks.map((peak, idx) => (
          <TableRow
            key={idx}
            className={cn(
              peak.is_solvent_front && 'opacity-50',
              peak.is_main_peak && 'bg-primary/5 font-medium'
            )}
          >
            <TableCell className="font-mono text-xs">{idx + 1}</TableCell>
            <TableCell className="text-right font-mono">
              {peak.retention_time.toFixed(3)}
            </TableCell>
            <TableCell className="text-right font-mono">
              {peak.height.toFixed(4)}
            </TableCell>
            <TableCell className="text-right font-mono">
              {peak.area.toFixed(4)}
            </TableCell>
            <TableCell className="text-right font-mono">
              {peak.area_percent.toFixed(4)}
            </TableCell>
            <TableCell className="text-right font-mono text-muted-foreground">
              {peak.begin_time.toFixed(3)}
            </TableCell>
            <TableCell className="text-right font-mono text-muted-foreground">
              {peak.end_time.toFixed(3)}
            </TableCell>
            <TableCell>
              {peak.is_main_peak && (
                <Badge variant="default" className="text-xs">
                  Main
                </Badge>
              )}
              {peak.is_solvent_front && (
                <Badge variant="secondary" className="text-xs">
                  Solvent
                </Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
        <TableRow className="border-t-2 font-medium">
          <TableCell colSpan={3}>Sum</TableCell>
          <TableCell className="text-right font-mono">
            {totalArea.toFixed(4)}
          </TableCell>
          <TableCell colSpan={4}></TableCell>
        </TableRow>
      </TableBody>
    </Table>
  )
}
