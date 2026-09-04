/**
 * Room a page header leaves for the floating menu button, given back where that button hides.
 *
 * The button is `fixed` and overlaps the page, so nothing in the layout accounts for it — a header
 * that forgets this sits underneath it. One constant because the two halves have to move together:
 * a reserve that outlives the button is a 48px indent no layout explains.
 */
export const PAGE_HEADER_RESERVE = 'pl-12 nav:pl-0'
