import { Plus } from 'lucide-react'
import { useRef, useState } from 'react'

export function AddItemForm({ onAdd }: { onAdd: (text: string) => Promise<void> }) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmedText = text.trim()
    if (!trimmedText) return

    const previousText = text
    setText('')
    try {
      await onAdd(trimmedText)
      inputRef.current?.focus()
    } catch {
      setText(previousText)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="px-3 sm:px-4 py-2.5 border-t border-zinc-800 flex items-center gap-2 shrink-0"
    >
      <Plus size={14} className="text-zinc-600 shrink-0" />
      {/* text-base keeps mobile at 16px; below that iOS (any browser — all WebKit) zooms on focus */}
      <input
        ref={inputRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Add item…"
        className="flex-1 bg-transparent text-base sm:text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none"
      />
      {text.trim() && (
        <button
          type="submit"
          className="text-xs text-zinc-400 hover:text-zinc-100 transition-colors"
        >
          Add
        </button>
      )}
    </form>
  )
}
