/** One trashed dashboard or list: its name, how long until the reaper takes it, restore and purge. */
export function TrashRow({
  name,
  purgeAt,
  busy,
  onRestore,
  onPurge,
}: {
  name: string
  purgeAt: string
  busy: 'restoring' | 'purging' | null
  onRestore: () => void
  onPurge: () => void
}) {
  const days = Math.max(0, Math.ceil((new Date(purgeAt).getTime() - Date.now()) / 86_400_000))
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-zinc-300">{name}</p>
        <p className="text-xs text-zinc-600">
          {days === 0
            ? 'Will be permanently deleted soon'
            : `Permanently deleted in ${days} day${days === 1 ? '' : 's'}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onRestore}
          disabled={busy !== null}
          className="shrink-0 rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
        >
          {busy === 'restoring' ? 'Restoring…' : 'Restore'}
        </button>
        <button
          type="button"
          onClick={onPurge}
          disabled={busy !== null}
          className="shrink-0 rounded border border-zinc-800 px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:border-red-900 hover:text-red-400 disabled:opacity-50"
        >
          {busy === 'purging' ? 'Deleting…' : 'Delete permanently'}
        </button>
      </div>
    </div>
  )
}
