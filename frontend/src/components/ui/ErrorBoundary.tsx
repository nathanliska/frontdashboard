import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Contain a render-time crash instead of letting it unmount the whole app.
 *
 * React unmounts the entire tree on an uncaught render error, so without a boundary anywhere the
 * result is a blank page. That is bad here in a specific way: dashboards render user-authored
 * content, so a crash is likely to be *deterministic* — the same data throws again on reload, and
 * the app stays unusable for that user rather than recovering.
 *
 * Placed at two levels. Around the app it is the last resort, and offers a reload. Around each
 * widget it is the useful one: a dashboard is a grid of independent widgets, and one throwing
 * widget should cost you that tile, not the page it sits on.
 *
 * A class, because `getDerivedStateFromError`/`componentDidCatch` have no hook equivalent — this
 * is the one place React still requires one.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (reset: () => void) => ReactNode; label?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Matches the diagnostics in api/http.ts and hooks/useSSE.ts: there is no error-reporting
    // backend, so the console is the only place a crash leaves a trace worth having.
    console.error(
      `Render error${this.props.label ? ` in ${this.props.label}` : ''}`,
      error,
      info.componentStack,
    )
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) return this.props.fallback(this.reset)
    return this.props.children
  }
}
