/**
 * Reveal a just-added list item. Without a selector the newest item is assumed to sit at the
 * bottom of the scroller; with one, the last match is scrolled into view instead — the checked
 * pile renders below the active zone, so "bottom of the scroller" can hide a fresh active row.
 */
export function scrollToNewestItem(container: HTMLElement | null, newestSelector?: string) {
  if (!container) return
  // The append only renders once the mutation resolves — wait for that commit before measuring.
  requestAnimationFrame(() => {
    // The frame can land after the view is gone (navigation, widget removed): scrolling a
    // detached container measures nothing and would search a subtree that no longer exists.
    if (!container.isConnected) return
    if (newestSelector) {
      const matches = container.querySelectorAll(newestSelector)
      const newest = matches[matches.length - 1]
      if (newest) {
        newest.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        return
      }
    }
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  })
}
