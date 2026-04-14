export function cn(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}
