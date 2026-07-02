// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab, TuiAgent } from '../../../shared/types'
import { useTabAgent } from './use-tab-agent'

const initialAppState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
let latestHookAgent: TuiAgent | null | undefined
let root: Root | null = null

function HookProbe({ tab }: { tab: TerminalTab }): null {
  latestHookAgent = useTabAgent(tab)
  return null
}

async function renderHookProbe(tab: TerminalTab): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(createElement(HookProbe, { tab }))
  })
  await flushHookEffects()
}

async function flushHookEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function singlePaneLayout(ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: ptyId }
  }
}

describe('useTabAgent launch lifecycle', () => {
  const originalApi = window.api
  const getForegroundProcess = vi.fn()
  const clearTabLaunchAgent = vi.fn()
  const baseTab: TerminalTab = {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: 'opencode'
  }

  beforeEach(() => {
    latestHookAgent = undefined
    getForegroundProcess.mockReset()
    clearTabLaunchAgent.mockReset()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      agentStatusByPaneKey: {},
      terminalLayoutsByTabId: {},
      clearTabLaunchAgent
    })
    window.api = {
      ...originalApi,
      pty: {
        ...originalApi?.pty,
        getForegroundProcess
      }
    } as typeof window.api
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    root = null
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    window.api = originalApi
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('clears launch identity when bounded startup shell retries never observe the agent', async () => {
    vi.useFakeTimers()
    getForegroundProcess.mockResolvedValue('zsh')

    await renderHookProbe(baseTab)
    expect(latestHookAgent).toBeNull()

    await act(async () => vi.advanceTimersByTimeAsync(250 + 1250 + 3500 + 750))
    await flushHookEffects()

    expect(getForegroundProcess).toHaveBeenCalledTimes(5)
    expect(clearTabLaunchAgent).toHaveBeenCalledExactlyOnceWith('tab-1')
    expect(latestHookAgent).toBeNull()
  })

  it('re-reads foreground on command finish so an exited auto-launched agent clears from the tab', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess.mockResolvedValueOnce('opencode').mockResolvedValueOnce('zsh')
    useAppStore.setState({
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-1') }
    })

    await renderHookProbe(baseTab)

    expect(latestHookAgent).toBe('opencode')
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toMatchObject({
      agent: 'opencode',
      ptyId: 'pty-1'
    })

    await act(async () => {
      useAppStore.getState().markTerminalCommandFinished(paneKey)
    })
    await flushHookEffects()

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(latestHookAgent).toBeNull()
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
    expect(clearTabLaunchAgent).toHaveBeenCalledExactlyOnceWith('tab-1')
  })

  it('does not keep painting a pre-finish foreground snapshot while the shell read is pending', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const shellRead = deferred<string>()
    getForegroundProcess.mockResolvedValueOnce('opencode').mockReturnValueOnce(shellRead.promise)
    useAppStore.setState({
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-1') }
    })

    await renderHookProbe(baseTab)

    expect(latestHookAgent).toBe('opencode')
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toMatchObject({
      agent: 'opencode',
      ptyId: 'pty-1'
    })

    await act(async () => {
      useAppStore.getState().markTerminalCommandFinished(paneKey)
    })
    await flushHookEffects()

    expect(latestHookAgent).toBeNull()
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()

    await act(async () => {
      shellRead.resolve('zsh')
    })
    await flushHookEffects()

    expect(latestHookAgent).toBeNull()
  })

  it('ignores same-command stale agent reads after command finish clears the tab', async () => {
    vi.useFakeTimers()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('zsh')
    useAppStore.setState({
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-1') }
    })

    try {
      await renderHookProbe(baseTab)

      expect(latestHookAgent).toBe('opencode')

      await act(async () => {
        useAppStore.getState().markTerminalCommandFinished(paneKey)
      })
      await flushHookEffects()

      expect(latestHookAgent).toBeNull()
      expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250)
      })
      await flushHookEffects()

      expect(getForegroundProcess).toHaveBeenCalledTimes(3)
      expect(latestHookAgent).toBeNull()
      expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('ignores stale agent foreground reads that resolve after command finish', async () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const staleAgentRead = deferred<string>()
    getForegroundProcess.mockReturnValueOnce(staleAgentRead.promise).mockResolvedValueOnce('zsh')
    useAppStore.setState({
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-1') }
    })

    await renderHookProbe(baseTab)

    await act(async () => {
      useAppStore.getState().markTerminalCommandFinished(paneKey)
    })
    await flushHookEffects()

    await act(async () => {
      staleAgentRead.resolve('opencode')
    })
    await flushHookEffects()

    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
    expect(latestHookAgent).toBeNull()
    expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
  })

  it('rechecks after interrupt input when the command-finished event does not advance', async () => {
    vi.useFakeTimers()
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    getForegroundProcess
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('zsh')
    useAppStore.setState({
      terminalLayoutsByTabId: { 'tab-1': singlePaneLayout('pty-1') }
    })

    try {
      await renderHookProbe(baseTab)

      expect(latestHookAgent).toBe('opencode')
      expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toMatchObject({
        agent: 'opencode',
        ptyId: 'pty-1'
      })

      await act(async () => {
        useAppStore.getState().markTerminalInterruptInput(paneKey)
      })
      await flushHookEffects()

      expect(latestHookAgent).toBe('opencode')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250 + 1250 + 2500)
      })
      await flushHookEffects()

      expect(latestHookAgent).toBe('opencode')

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      await flushHookEffects()

      expect(getForegroundProcess).toHaveBeenCalledTimes(6)
      expect(latestHookAgent).toBeNull()
      expect(useAppStore.getState().foregroundAgentByPaneKey[paneKey]).toBeUndefined()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
