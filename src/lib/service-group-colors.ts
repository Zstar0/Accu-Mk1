export const SERVICE_GROUP_COLORS = {
  blue:    'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300',
  amber:   'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300',
  emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300',
  red:     'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300',
  violet:  'bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300',
  zinc:    'bg-zinc-100 text-zinc-800 border-zinc-200 dark:bg-zinc-900/30 dark:text-zinc-300',
  rose:    'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300',
  sky:     'bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300',
} as const

export type ServiceGroupColor = keyof typeof SERVICE_GROUP_COLORS

export const COLOR_OPTIONS: { value: ServiceGroupColor; label: string }[] = [
  { value: 'blue',    label: 'Blue' },
  { value: 'amber',   label: 'Amber' },
  { value: 'emerald', label: 'Emerald' },
  { value: 'red',     label: 'Red' },
  { value: 'violet',  label: 'Violet' },
  { value: 'zinc',    label: 'Zinc' },
  { value: 'rose',    label: 'Rose' },
  { value: 'sky',     label: 'Sky' },
]
