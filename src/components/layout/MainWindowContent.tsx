import { useState, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { FileSelector } from '@/components/FileSelector'
import { BatchReview } from '@/components/BatchReview'
import { AccuMarkTools } from '@/components/AccuMarkTools'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useUIStore } from '@/store/ui-store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { KeyRound, Settings } from 'lucide-react'
import { hasApiKey, API_PROFILE_CHANGED_EVENT } from '@/lib/api-profiles'

interface MainWindowContentProps {
  children?: React.ReactNode
  className?: string
}

export function MainWindowContent({
  children,
  className,
}: MainWindowContentProps) {
  const activeSection = useUIStore(state => state.activeSection)
  const setPreferencesOpen = useUIStore(state => state.setPreferencesOpen)
  const [apiKeyConfigured, setApiKeyConfigured] = useState(true) // Default true to avoid flash

  // Check for API key on mount, when section changes, and when profile changes
  useEffect(() => {
    const checkApiKey = () => setApiKeyConfigured(hasApiKey())
    
    // Initial check
    checkApiKey()
    
    // Listen for profile changes
    window.addEventListener(API_PROFILE_CHANGED_EVENT, checkApiKey)
    
    return () => {
      window.removeEventListener(API_PROFILE_CHANGED_EVENT, checkApiKey)
    }
  }, [activeSection])

  // Render API key required message
  const renderApiKeyRequired = () => (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900">
            <KeyRound className="h-6 w-6 text-blue-600 dark:text-blue-300" />
          </div>
          <CardTitle>API Key Required</CardTitle>
          <CardDescription>
            To use this feature, you need to configure your API key in Settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button onClick={() => setPreferencesOpen(true)} className="gap-2">
            <Settings className="h-4 w-4" />
            Open Settings
          </Button>
        </CardContent>
      </Card>
    </div>
  )

  // Render section content based on active section
  const renderSectionContent = () => {
    // Check for API key first
    if (!apiKeyConfigured) {
      return renderApiKeyRequired()
    }

    switch (activeSection) {
      case 'lab-operations':
        return (
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-6 p-6">
              <FileSelector />
              <BatchReview />
            </div>
          </ScrollArea>
        )
      case 'accumark-tools':
        return <AccuMarkTools />
      default:
        return null
    }
  }

  return (
    <div className={cn('flex h-full flex-col bg-background', className)}>
      {children || renderSectionContent()}
    </div>
  )
}

