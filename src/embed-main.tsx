import ReactDOM from 'react-dom/client'
import { useEffect, useState } from 'react'
import './i18n'
import './App.css'
import { DocumentEmbed } from '@/components/documents/DocumentEmbed'

function EmbedApp() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return <DocumentEmbed hash={hash} />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <EmbedApp />
)
