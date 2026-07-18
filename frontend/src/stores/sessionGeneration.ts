// Monotonic counter bumped at every auth boundary. Async store writes capture it at entry and
// no-op if it has moved, so a request begun under one session can't write into the next.
let generation = 0

export function bumpSessionGeneration(): void {
  generation += 1
}

export function currentSessionGeneration(): number {
  return generation
}
