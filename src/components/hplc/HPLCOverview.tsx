import { Microscope, ArrowRight } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useUIStore } from '@/store/ui-store'

export function HPLCOverview() {
  const navigateTo = useUIStore(state => state.navigateTo)

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">HPLC Analysis</h1>
        <p className="text-muted-foreground">
          Automated purity, quantity, and identity calculations from Agilent
          HPLC PeakData files.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card
          className="cursor-pointer transition-colors hover:bg-muted/50"
          onClick={() => navigateTo('hplc-analysis', 'new-analysis')}
        >
          <CardHeader>
            <div className="flex items-center gap-2">
              <Microscope className="h-5 w-5 text-primary" />
              <CardTitle className="text-base">New Analysis</CardTitle>
            </div>
            <CardDescription>
              Drop PeakData CSV files to parse peaks and calculate purity.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="ghost" size="sm" className="gap-1 p-0">
              Start analysis <ArrowRight className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card className="opacity-60">
          <CardHeader>
            <CardTitle className="text-base">Peptide Config</CardTitle>
            <CardDescription>
              Manage peptides, reference retention times, and calibration curves.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <span className="text-xs text-muted-foreground">Coming soon</span>
          </CardContent>
        </Card>

        <Card className="opacity-60">
          <CardHeader>
            <CardTitle className="text-base">Analysis History</CardTitle>
            <CardDescription>
              Browse past analyses with full calculation traces and audit trail.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <span className="text-xs text-muted-foreground">Coming soon</span>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
