/**
 * Deterministic member colors: hashed from the user id into a fixed palette, so
 * every device shows the same color with zero configuration. Collisions are possible in a small
 * palette; the initial rendered inside the dot is what disambiguates them.
 */

// Tailwind 400-series hues — legible fills on the app's dark surfaces.
const PALETTE = [
  '#f87171', // red
  '#fb923c', // orange
  '#fbbf24', // amber
  '#a3e635', // lime
  '#34d399', // emerald
  '#22d3ee', // cyan
  '#60a5fa', // blue
  '#a78bfa', // violet
  '#f472b6', // pink
  '#fb7185', // rose
] as const

export function participantColor(userId: string): string {
  let hash = 5381
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) + hash + userId.charCodeAt(i)) | 0
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

export function participantInitial(displayName: string): string {
  const first = displayName.trim()[0]
  return first ? first.toUpperCase() : '?'
}
