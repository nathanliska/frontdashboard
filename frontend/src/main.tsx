import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ui/ErrorBoundary.tsx'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element not found')
}

createRoot(rootElement).render(
  <StrictMode>
    {/* Last resort. Widgets carry their own boundary, so reaching this one means the crash was
        outside a tile — navigation, a page, a store read. Offers a reload rather than a reset,
        because whatever state produced it is still in memory. */}
    <ErrorBoundary
      label="app root"
      fallback={() => (
        <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-zinc-950 p-6 text-center">
          <p className="text-sm text-zinc-300">Something went wrong.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            Reload
          </button>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
