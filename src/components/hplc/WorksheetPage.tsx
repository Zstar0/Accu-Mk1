import { useQuery } from '@tanstack/react-query'
import { getWorksheet } from '@/lib/api'
import { worksheetPageKey } from '@/hooks/use-worksheet-drawer'
import { worksheetKind } from '@/lib/worksheet-kind'
import { useUIStore } from '@/store/ui-store'
import { EndoWorksheetPage } from '@/components/hplc/endo/EndoWorksheetPage'
import { HplcWorksheetPage } from '@/components/hplc/prep/HplcWorksheetPage'

/**
 * The worksheet page (#hplc-analysis/worksheet?id=N) by bench kind: an
 * all-HPLC worksheet gets the HPLC prep sheet; everything else goes to the
 * endo page, which keeps its own loading, error and "not an endotoxin
 * worksheet" messages. Same query key as the endo page, so one fetch serves
 * both.
 */
export function WorksheetPage() {
  const worksheetId = useUIStore(state => state.worksheetPageId)
  const { data: worksheet } = useQuery({
    queryKey: worksheetPageKey(worksheetId ?? 0),
    queryFn: () => getWorksheet(worksheetId ?? 0),
    enabled: worksheetId != null,
  })
  if (worksheet && worksheetKind(worksheet.items) === 'hplc')
    return <HplcWorksheetPage key={worksheet.id} worksheet={worksheet} />
  return <EndoWorksheetPage />
}

export default WorksheetPage
