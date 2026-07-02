import { useAppStore } from '@/store'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'

const ACTIVE_FOREGROUND_PANE_SEPARATOR = '\u0000'

function paneKeyForTerminalLeaf(tabId: string, leafId: string | null | undefined): string | null {
  return leafId && isTerminalLeafId(leafId) ? makePaneKey(tabId, leafId) : null
}

export function useTabAgentForegroundSignals(tabId: string): {
  ptyId: string | null
  foregroundPaneKey: string | null
  foregroundLifecycleKey: string
  foregroundCommandFinishedEpoch: number
  foregroundInterruptEpoch: number
  foregroundInputEpoch: number
  isRemoteLike: boolean
} {
  const activeForegroundPaneKey = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tabId]
    const activeLeafId =
      layout?.activeLeafId ?? (layout?.root?.type === 'leaf' ? layout.root.leafId : null)
    const leafPty = activeLeafId ? layout?.ptyIdsByLeafId?.[activeLeafId] : undefined
    const ptyIds = s.ptyIdsByTabId[tabId] ?? []
    const ptyId = activeLeafId && leafPty && ptyIds.includes(leafPty) ? leafPty : null
    if (ptyId) {
      return `${ptyId}${ACTIVE_FOREGROUND_PANE_SEPARATOR}${paneKeyForTerminalLeaf(tabId, activeLeafId) ?? ''}`
    }
    // Why: without a focused leaf, a split tab's first PTY can be a sibling
    // shell. Only single-PTY fallback foreground is authoritative.
    const fallbackPtyId = ptyIds.length === 1 ? ptyIds[0]! : ''
    const fallbackPaneKey =
      ptyIds.length === 1 ? (paneKeyForTerminalLeaf(tabId, activeLeafId) ?? '') : ''
    return `${fallbackPtyId}${ACTIVE_FOREGROUND_PANE_SEPARATOR}${fallbackPaneKey}`
  })
  const [ptyIdRaw, foregroundPaneKeyRaw] = activeForegroundPaneKey.split(
    ACTIVE_FOREGROUND_PANE_SEPARATOR
  )
  const ptyId = ptyIdRaw || null
  const foregroundPaneKey = foregroundPaneKeyRaw || null
  const foregroundLifecycleKey = useAppStore((s) => {
    if (!foregroundPaneKey) {
      return 'none'
    }
    const commandFinishedEpoch = s.terminalCommandFinishedEpochByPaneKey[foregroundPaneKey] ?? 0
    const interruptInputEpoch = s.terminalInterruptInputEpochByPaneKey[foregroundPaneKey] ?? 0
    const entry = s.agentStatusByPaneKey[foregroundPaneKey]
    if (!entry) {
      return `none:${commandFinishedEpoch}:${interruptInputEpoch}`
    }
    // Why: hook lifecycle transitions and shell command completion can signal
    // a foreground change even when the PTY and terminal title are unchanged.
    return `${entry.state}:${entry.stateStartedAt}:${entry.agentType}:${entry.terminalTitle ?? ''}:${commandFinishedEpoch}:${interruptInputEpoch}`
  })
  const foregroundCommandFinishedEpoch = useAppStore((s) =>
    foregroundPaneKey ? (s.terminalCommandFinishedEpochByPaneKey[foregroundPaneKey] ?? 0) : 0
  )
  const foregroundInterruptEpoch = useAppStore((s) =>
    foregroundPaneKey ? (s.terminalInterruptInputEpochByPaneKey[foregroundPaneKey] ?? 0) : 0
  )
  const foregroundInputEpoch = useAppStore((s) =>
    foregroundPaneKey ? (s.lastTerminalInputAtByPaneKey[foregroundPaneKey] ?? 0) : 0
  )
  const isRemoteLike = useAppStore((s) => {
    const layout = s.terminalLayoutsByTabId[tabId]
    const ptyIds = new Set(s.ptyIdsByTabId[tabId] ?? [])
    for (const ptyId of Object.values(layout?.ptyIdsByLeafId ?? {})) {
      ptyIds.add(ptyId)
    }
    return [...ptyIds].some((ptyId) => parseRemoteRuntimePtyId(ptyId) !== null)
  })

  return {
    ptyId,
    foregroundPaneKey,
    foregroundLifecycleKey,
    foregroundCommandFinishedEpoch,
    foregroundInterruptEpoch,
    foregroundInputEpoch,
    isRemoteLike
  }
}
