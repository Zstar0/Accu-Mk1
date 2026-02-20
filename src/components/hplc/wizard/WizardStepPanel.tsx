import { useRef, useState, useEffect } from 'react'

interface WizardStepPanelProps {
  children: React.ReactNode
  stepId: number
}

export function WizardStepPanel({ children, stepId }: WizardStepPanelProps) {
  const prevStepRef = useRef<number>(stepId)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')

  useEffect(() => {
    if (prevStepRef.current !== stepId) {
      setDirection(stepId > prevStepRef.current ? 'forward' : 'back')
      prevStepRef.current = stepId
    }
  }, [stepId])

  const animationClass =
    direction === 'forward'
      ? 'animate-in slide-in-from-right-4 fade-in duration-200'
      : 'animate-in slide-in-from-left-4 fade-in duration-200'

  return (
    <div key={stepId} className={animationClass}>
      {children}
    </div>
  )
}
