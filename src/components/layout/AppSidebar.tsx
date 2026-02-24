import {
  ChevronRight,
  FlaskConical,
  Microscope,
  Wrench,
  Settings,
  Activity,
  Users,
  LogOut,
  LayoutDashboard,
  RefreshCw,
  ClipboardList,
} from 'lucide-react'
import { relaunch } from '@tauri-apps/plugin-process'
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
import { useAuthStore } from '@/store/auth-store'
import { logout } from '@/lib/auth-api'

interface SubItem {
  id: ActiveSubSection
  label: string
  adminOnly?: boolean
}

interface NavItem {
  id: ActiveSection
  label: string
  icon: React.ComponentType<{ className?: string }>
  subItems?: SubItem[]
}

const navItems: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    subItems: [
      { id: 'orders', label: 'Orders' },
      { id: 'analytics', label: 'Analytics' },
    ],
  },
  {
    id: 'senaite',
    label: 'SENAITE',
    icon: FlaskConical,
    subItems: [
      { id: 'samples', label: 'Samples' },
      { id: 'event-log', label: 'Event Log' },
    ],
  },
  {
    id: 'intake',
    label: 'Intake',
    icon: ClipboardList,
    subItems: [
      { id: 'receive-sample', label: 'Receive Sample' },
    ],
  },
  {
    id: 'lab-operations',
    label: 'Lab Operations',
    icon: FlaskConical,
    subItems: [
      { id: 'chromatographs', label: 'Chromatographs' },
    ],
  },
  {
    id: 'hplc-analysis',
    label: 'HPLC Analysis',
    icon: Microscope,
    subItems: [
      { id: 'overview', label: 'Overview' },
      { id: 'new-analysis', label: 'New Analysis' },
      { id: 'import-analysis', label: 'Import Analysis' },
      { id: 'peptide-config', label: 'Peptide Standards' },
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
      { id: 'coa-explorer', label: 'COA Explorer' },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    icon: Users,
    subItems: [
      { id: 'change-password', label: 'Change Password' },
      { id: 'user-management', label: 'User Management', adminOnly: true },
    ],
  },
]

export function AppSidebar() {
  const activeSection = useUIStore(state => state.activeSection)
  const activeSubSection = useUIStore(state => state.activeSubSection)
  const navigateTo = useUIStore(state => state.navigateTo)
  const setPreferencesOpen = useUIStore(state => state.setPreferencesOpen)
  const updateVersion = useUIStore(state => state.updateVersion)
  const updateReady = useUIStore(state => state.updateReady)
  const user = useAuthStore(state => state.user)
  const isAdmin = user?.role === 'admin'

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
                const visibleSubItems = item.subItems?.filter(
                  sub => !sub.adminOnly || isAdmin
                )
                const hasSubItems = visibleSubItems && visibleSubItems.length > 0

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
                            {visibleSubItems?.map(subItem => {
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
        {updateReady && (
          <button
            type="button"
            onClick={() => relaunch()}
            className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2"
          >
            <RefreshCw className="h-3.5 w-3.5 shrink-0" />
            <span className="group-data-[collapsible=icon]:hidden">
              v{updateVersion} ready — Restart to update
            </span>
          </button>
        )}
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
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Sign Out"
              onClick={() => logout()}
            >
              <LogOut className="h-4 w-4" />
              <span>Sign Out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {user && (
          <div className="px-3 py-1 text-xs text-muted-foreground truncate group-data-[collapsible=icon]:hidden">
            {user.email}
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  )
}
