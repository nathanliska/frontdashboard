/**
 * Reveal a just-added list item. Adds always append to the end of the list, so the newest item
 * is at the bottom of the scroller.
 */
export function scrollToNewestItem(container: HTMLElement | null) {
  if (!container) return
  // The append only renders once the mutation resolves — wait for that commit before measuring.
  requestAnimationFrame(() => {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  })
}
