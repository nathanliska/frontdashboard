import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MoreVertical } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '../../utils/shared/cn'

export interface OverflowMenuItem {
  label: string
  icon?: ComponentType<{ size?: number | string }>
  onSelect: () => void
  tone?: 'default' | 'danger'
  disabled?: boolean
}

/** Visible actions menu, on Radix DropdownMenu.
 *
 * Replaces the hover-only icon rows: hover reveals don't exist on touch and are invisible to
 * anyone who doesn't already know to hover. The trigger is always visible with a ≥44px hit
 * target; Radix supplies aria-expanded/haspopup, arrow-key navigation, Escape, and focus return.
 * Click/keydown are stopped so a menu inside a clickable card doesn't also activate the card.
 */
export function OverflowMenu({ label, items }: { label: string; items: OverflowMenuItem[] }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 sm:h-8 sm:w-8"
        >
          <MoreVertical size={15} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          onClick={(event) => event.stopPropagation()}
          className="z-50 min-w-44 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-2xl"
        >
          {items.map((item) => {
            const Icon = item.icon
            return (
              <DropdownMenu.Item
                key={item.label}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2.5 text-sm outline-none transition-colors sm:py-2',
                  'data-disabled:pointer-events-none data-disabled:opacity-40',
                  item.tone === 'danger'
                    ? 'text-red-400 data-highlighted:bg-red-500/10 data-highlighted:text-red-300'
                    : 'text-zinc-300 data-highlighted:bg-zinc-800 data-highlighted:text-zinc-100',
                )}
              >
                {Icon && <Icon size={14} />}
                {item.label}
              </DropdownMenu.Item>
            )
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
