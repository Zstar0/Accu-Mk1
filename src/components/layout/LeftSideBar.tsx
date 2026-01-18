import { cn } from '@/lib/utils'
import { useUIStore, type ActiveSection } from '@/store/ui-store'
import { Button } from '@/components/ui/button'
import { FlaskConical, Wrench } from 'lucide-react'

interface NavItem {
  id: ActiveSection
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { id: 'lab-operations', label: 'Lab Operations', icon: FlaskConical },
  { id: 'accumark-tools', label: 'AccuMark Tools', icon: Wrench },
]

interface LeftSideBarProps {
  children?: React.ReactNode
  className?: string
}

export function LeftSideBar({ children, className }: LeftSideBarProps) {
  const activeSection = useUIStore(state => state.activeSection)
  const setActiveSection = useUIStore(state => state.setActiveSection)

  return (
    <div
      className={cn('flex h-full flex-col border-r bg-background', className)}
    >
      {/* Navigation */}
      <nav className="flex flex-col gap-1 p-2">
        {navItems.map(item => {
          const Icon = item.icon
          const isActive = activeSection === item.id
          return (
            <Button
              key={item.id}
              variant={isActive ? 'secondary' : 'ghost'}
              className={cn(
                'w-full justify-start gap-2',
                isActive && 'bg-secondary'
              )}
              onClick={() => setActiveSection(item.id)}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Button>
          )
        })}
      </nav>
      
      {/* Additional content passed as children */}
      {children}
    </div>
  )
}
