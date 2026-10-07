// src/components/documents/annotations/label-colors.ts
/** plannotator's LABEL_COLOR_MAP (MIT), keyed by the catalog's `color`. */
export const LABEL_COLOR_MAP: Record<
  string,
  { bg: string; text: string; darkText: string }
> = {
  blue: { bg: 'rgba(59,130,246,0.15)', text: '#2563eb', darkText: '#60a5fa' },
  red: { bg: 'rgba(239,68,68,0.15)', text: '#dc2626', darkText: '#f87171' },
  orange: { bg: 'rgba(249,115,22,0.15)', text: '#ea580c', darkText: '#fb923c' },
  yellow: { bg: 'rgba(234,179,8,0.15)', text: '#ca8a04', darkText: '#facc15' },
  purple: { bg: 'rgba(147,51,234,0.15)', text: '#9333ea', darkText: '#a78bfa' },
  teal: { bg: 'rgba(20,184,166,0.15)', text: '#0d9488', darkText: '#2dd4bf' },
  pink: { bg: 'rgba(236,72,153,0.15)', text: '#db2777', darkText: '#f472b6' },
  green: { bg: 'rgba(34,197,94,0.15)', text: '#16a34a', darkText: '#4ade80' },
  cyan: { bg: 'rgba(8,145,178,0.15)', text: '#0891b2', darkText: '#22d3ee' },
  amber: { bg: 'rgba(180,83,9,0.15)', text: '#b45309', darkText: '#fbbf24' },
}

export function labelStyle(
  color: string,
  dark: boolean
): { backgroundColor: string; color: string } {
  const c = LABEL_COLOR_MAP[color]
  if (!c) return { backgroundColor: 'rgba(128,128,128,0.15)', color: '#666' }
  return { backgroundColor: c.bg, color: dark ? c.darkText : c.text }
}
