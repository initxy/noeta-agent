/**
 * The entry point. It imports the shell and nothing else from the app tree —
 * every other wiring decision lives one layer down.
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppProviders } from '@/react-app/shell/providers'
import { AppRoot } from '@/react-app/shell/app-root'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <AppRoot />
    </AppProviders>
  </StrictMode>,
)
