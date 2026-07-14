/**
 * Shared settings-pane registry.
 *
 * The nav list + pane-id→component map, extracted from the retired
 * PreferencesDialog so the full-page `SettingsPage` (#settings/<pane>) and any
 * future opener share one source of truth. Pane components live unchanged under
 * ./panes/*; only the registry moved here.
 */
import {
  Settings,
  Palette,
  Zap,
  Database,
  DatabaseZap,
  Timer,
  CalendarClock,
  Flag,
  ClipboardCheck,
  GitBranch,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import { GeneralPane } from './panes/GeneralPane'
import { AppearancePane } from './panes/AppearancePane'
import { DataPipelinePane } from './panes/DataPipelinePane'
import { DataSourcePane } from './panes/DataSourcePane'
import { AdvancedPane } from './panes/AdvancedPane'
import { SlaPane } from './panes/SlaPane'
import { BusinessHoursPane } from './panes/BusinessHoursPane'
import { FlagsPane } from './panes/FlagsPane'
import { CheckInPane } from './panes/CheckInPane'
import { WorkflowPane } from './panes/WorkflowPane'

export type PreferencePane =
  | 'general'
  | 'appearance'
  | 'dataPipeline'
  | 'dataSource'
  | 'sla'
  | 'businessHours'
  | 'flags'
  | 'checkIn'
  | 'workflow'
  | 'advanced'

interface NavigationItem {
  id: PreferencePane
  labelKey: string
  icon: LucideIcon
}

export const navigationItems: readonly NavigationItem[] = [
  { id: 'general', labelKey: 'preferences.general', icon: Settings },
  { id: 'appearance', labelKey: 'preferences.appearance', icon: Palette },
  { id: 'dataPipeline', labelKey: 'preferences.dataPipeline', icon: Database },
  { id: 'dataSource', labelKey: 'preferences.dataSource', icon: DatabaseZap },
  { id: 'sla', labelKey: 'preferences.sla', icon: Timer },
  {
    id: 'businessHours',
    labelKey: 'preferences.businessHours',
    icon: CalendarClock,
  },
  { id: 'flags', labelKey: 'preferences.flags', icon: Flag },
  { id: 'checkIn', labelKey: 'preferences.checkIn', icon: ClipboardCheck },
  { id: 'workflow', labelKey: 'preferences.workflow', icon: GitBranch },
  { id: 'advanced', labelKey: 'preferences.advanced', icon: Zap },
] as const

export const PANE_COMPONENTS: Record<PreferencePane, ComponentType> = {
  general: GeneralPane,
  appearance: AppearancePane,
  dataPipeline: DataPipelinePane,
  dataSource: DataSourcePane,
  sla: SlaPane,
  businessHours: BusinessHoursPane,
  flags: FlagsPane,
  checkIn: CheckInPane,
  workflow: WorkflowPane,
  advanced: AdvancedPane,
}

/** Whether a subsection slug names a real settings pane. */
export function isPreferencePane(id: string): id is PreferencePane {
  return id in PANE_COMPONENTS
}
