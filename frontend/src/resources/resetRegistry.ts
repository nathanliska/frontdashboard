/**
 * Sign-out reset hooks, registered by the caches themselves.
 *
 * A cache that forgets to wire itself into the sign-out path leaks one account's data into the
 * next session, so registration lives beside the cache it clears rather than in a list somewhere
 * else that has to be kept in step.
 */

type ResetFn = () => void

const resets = new Set<ResetFn>()

/** Call at module scope, next to the cache being registered. */
export function registerResourceReset(reset: ResetFn): void {
  resets.add(reset)
}

/** Clear every registered cache. Called when the signed-in identity changes. */
export function resetAllResourceData(): void {
  for (const reset of resets) reset()
}
