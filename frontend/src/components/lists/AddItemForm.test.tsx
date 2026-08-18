// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddItemForm } from './AddItemForm'

const onAdd = vi.fn(async () => {})
const onRestore = vi.fn(async () => {})

function renderForm(checkedItems = [{ id: 'item-milk', text: 'Milk' }]) {
  return render(<AddItemForm onAdd={onAdd} checkedItems={checkedItems} onRestore={onRestore} />)
}

function type(value: string) {
  fireEvent.change(screen.getByRole('combobox', { name: 'Add item' }), { target: { value } })
}

describe('AddItemForm toggle-dedupe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('unchecks the existing row instead of adding a duplicate on an exact match', () => {
    renderForm()
    type('milk')
    fireEvent.submit(screen.getByRole('combobox', { name: 'Add item' }))
    expect(onRestore).toHaveBeenCalledWith('item-milk')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('adds normally when nothing checked matches', () => {
    renderForm()
    type('Bread')
    fireEvent.submit(screen.getByRole('combobox', { name: 'Add item' }))
    expect(onAdd).toHaveBeenCalledWith('Bread')
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('restores a highlighted partial match via arrow keys + Enter', () => {
    renderForm()
    const input = screen.getByRole('combobox', { name: 'Add item' })
    type('mil')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.submit(input)
    expect(onRestore).toHaveBeenCalledWith('item-milk')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('Enter restores the row the user highlighted even if the pile reshuffles underneath', () => {
    const { rerender } = renderForm([{ id: 'item-milk', text: 'Milk' }])
    const input = screen.getByRole('combobox', { name: 'Add item' })
    type('mil')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    // A housemate checks "Almond milk", which sits earlier in the list and so enters the
    // suggestions above the highlighted row.
    rerender(
      <AddItemForm
        onAdd={onAdd}
        checkedItems={[
          { id: 'item-almond', text: 'Almond milk' },
          { id: 'item-milk', text: 'Milk' },
        ]}
        onRestore={onRestore}
      />,
    )
    fireEvent.submit(input)
    expect(onRestore).toHaveBeenCalledWith('item-milk')
  })

  it('restores on suggestion click', () => {
    renderForm()
    type('mil')
    fireEvent.mouseDown(screen.getByRole('option'))
    expect(onRestore).toHaveBeenCalledWith('item-milk')
  })

  it('Escape dismisses suggestions so an exact-name duplicate can still be added on purpose', () => {
    renderForm()
    const input = screen.getByRole('combobox', { name: 'Add item' })
    type('Milk')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.submit(input)
    expect(onAdd).toHaveBeenCalledWith('Milk')
    expect(onRestore).not.toHaveBeenCalled()
  })

  it('puts the typed text back when the restore fails', async () => {
    onRestore.mockRejectedValueOnce(new Error('offline'))
    renderForm()
    const input = screen.getByRole('combobox', { name: 'Add item' })
    type('milk')
    fireEvent.submit(input)
    // The input is cleared optimistically, then recovered so the word isn't lost to a toast.
    await waitFor(() => expect(input).toHaveValue('milk'))
  })

  it('names the highlighted suggestion so it is not a sighted-only cue', () => {
    renderForm([
      { id: 'item-milk', text: 'Milk' },
      { id: 'item-milkshake', text: 'Milkshake' },
    ])
    const input = screen.getByRole('combobox', { name: 'Add item' })
    type('milk')
    expect(input).not.toHaveAttribute('aria-activedescendant')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    // Focus never leaves the input, so aria-selected alone announces nothing — only
    // activedescendant tells a screen reader which row the arrow keys landed on.
    const [firstOption] = screen.getAllByRole('option')
    expect(firstOption.id).toBeTruthy()
    expect(input).toHaveAttribute('aria-activedescendant', firstOption.id)

    // Typing again drops the highlight, and the IDREF has to go with it.
    type('milks')
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('behaves as a plain add box when no restore wiring is provided', () => {
    // Checked items that match on purpose: without a restore there is nothing to toggle, so
    // the match must not swallow the submit and leave a form that neither adds nor unchecks.
    render(<AddItemForm onAdd={onAdd} checkedItems={[{ id: 'item-milk', text: 'Milk' }]} />)
    // No combobox semantics without a popup to control — a permanent collapsed combobox
    // with a dangling aria-controls is an axe failure.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: 'Add item' })
    fireEvent.change(input, { target: { value: 'Milk' } })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.submit(input)
    expect(onAdd).toHaveBeenCalledWith('Milk')
  })
})
