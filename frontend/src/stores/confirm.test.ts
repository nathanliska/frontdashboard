// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { createElement } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { confirm, useConfirmStore } from './confirm'

beforeEach(() => {
  useConfirmStore.getState().reset()
})

describe('confirm store concurrency', () => {
  it('cancels a concurrent request without replacing the active resolver', async () => {
    const first = confirm('First action?')
    const second = confirm('Second action?')

    await expect(second).resolves.toBe(false)
    expect(useConfirmStore.getState().message).toBe('First action?')

    useConfirmStore.getState()._accept()
    await expect(first).resolves.toBe(true)
  })

  it('cancels an active request when session state resets', async () => {
    const pending = confirm('Delete this?')

    useConfirmStore.getState().reset()

    await expect(pending).resolves.toBe(false)
    expect(useConfirmStore.getState()).toMatchObject({ open: false, message: '', _resolve: null })
  })

  it('cancels an active request when the dialog unmounts', async () => {
    const view = render(createElement(ConfirmDialog))
    let pending!: Promise<boolean>
    act(() => {
      pending = confirm('Delete this?')
    })

    view.unmount()

    await expect(pending).resolves.toBe(false)
  })
})
