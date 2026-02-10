import {
  ChevronRight,
  FlaskConical,
  Microscope,
  Wrench,
  Settings,
  Activity,
} from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarFooter,
  SidebarHeader,
} from '@/components/ui/sidebar'
import {
  useUIStore,
  type ActiveSection,
  type ActiveSubSection,
} from '@/store/ui-store'

interface SubItem {
  id: ActiveSubSection
  label: string
}

interface NavItem {
  id: ActiveSection
  label: string
  icon: React.ComponentType<{ className?: string }>
  subItems?: SubItem[]
}

const navItems: NavItem[] = [
  {
    id: 'lab-operations',
    label: 'Lab Operations',
    icon: FlaskConical,
    subItems: [
      { id: 'overview', label: 'Overview' },
      { id: 'chromatographs', label: 'Chromatographs' },
      { id: 'sample-intake', label: 'Sample Intake' },
      { id: 'results-entry', label: 'Results Entry' },
      { id: 'coa-generation', label: 'COA Generation' },
    ],
  },
  {
    id: 'hplc-analysis',
    label: 'HPLC Analysis',
    icon: Microscope,
    subItems: [
      { id: 'overview', label: 'Overview' },
      { id: 'new-analysis', label: 'New Analysis' },
      { id: 'peptide-config', label: 'Peptide Config' },
      { id: 'analysis-history', label: 'History' },
    ],
  },
  {
    id: 'accumark-tools',
    label: 'AccuMark Tools',
    icon: Wrench,
    subItems: [
      { id: 'overview', label: 'Overview' },
      { id: 'order-explorer', label: 'Order Explorer' },
    ],
  },
]

export function AppSidebar() {
  const activeSection = useUIStore(state => state.activeSection)
  const activeSubSection = useUIStore(state => state.activeSubSection)
  const navigateTo = useUIStore(state => state.navigateTo)
  const setPreferencesOpen = useUIStore(state => state.setPreferencesOpen)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-2 py-1">
          <Activity className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm group-data-[collapsible=icon]:hidden">
            Accu-Mk1
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map(item => {
                const Icon = item.icon
                const isActive = activeSection === item.id
                const hasSubItems = item.subItems && item.subItems.length > 0

                if (hasSubItems) {
                  return (
                    <Collapsible
                      key={item.id}
                      asChild
                      defaultOpen={isActive}
                      className="group/collapsible"
                    >
                      <SidebarMenuItem>
                        <CollapsibleTrigger asChild>
                          <SidebarMenuButton
                            tooltip={item.label}
                            isActive={isActive}
                          >
                            <Icon className="h-4 w-4" />
                            <span>{item.label}</span>
                            <ChevronRight className="ml-auto h-4 w-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                          </SidebarMenuButton>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {item.subItems?.map(subItem => {
                              const isSubActive =
                                isActive && activeSubSection === subItem.id
                              return (
                                <SidebarMenuSubItem key={subItem.id}>
                                  <SidebarMenuSubButton
                                    asChild
                                    isActive={isSubActive}
                                  >
                                    <button
                                      type="button"
                                      onClick={() =>
                                        navigateTo(item.id, subItem.id)
                                      }
                                    >
                                      <span>{subItem.label}</span>
                                    </button>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              )
                            })}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </SidebarMenuItem>
                    </Collapsible>
                  )
                }

                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      tooltip={item.label}
                      isActive={isActive}
                      onClick={() => navigateTo(item.id, 'overview')}
                    >
                      <Icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
              onClick={() => setPreferencesOpen(true)}
            >
              <Settings className="h-4 w-4" />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
