/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: tab agent foreground state is synchronized from PTY/remote agent signals and shell foreground events. */
import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/agent-detection'
import { getTitleForegroundKey } from '../../../shared/terminal-foreground-title-key'
import { useTabAgentForegroundSignals } from './tab-agent-foreground-signals'
import { resolveTabAgentFromSignals } from './tab-agent-signal-resolution'
import {
  resolveFocusedCompletedTabAgent,
  resolveFocusedTabAgent,
  resolveSiblingCompletedTabAgent,
  resolveSiblingTabAgent
} from './tab-agent'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TerminalTab, TuiAgent } from '../../../shared/types'

export { resolveTabAgentFromSignals, resolveTabAgentFromTitle } from './tab-agent-signal-resolution'

const HELPER_FOREGROUND_RETRY_DELAYS_MS = [250, 1250, 3500, 750] as const
const INTERRUPT_FOREGROUND_RECHECK_DELAYS_MS = [250, 1250, 2500, 5000, 10_000] as const

/**
 * Resolve which coding-harness agent a terminal tab is running, for its tab-bar
 * icon. Layered signals, most-authoritative first:
 *
 * 1. Live foreground process — the ground truth for what's running *now*: the
 *    only signal that reverts to the terminal glyph when the agent exits to a
 *    shell, or flips when a different agent starts in the same pane. Checked
 *    event-driven (when the tab's title or focused hook lifecycle changes —
 *    exactly when an agent starts/exits/takes a turn), never on an interval,
 *    and only for provider-routable panes. A recognized agent wins; a
 *    recognized shell authoritatively means "no agent".
 * 2. Hook status — accurate provider identity from native integrations, and
 *    available when foreground inspection is unsupported.
 * 3. Title — explicit title evidence; launchAgent is startup intent only.
 */
export function useTabAgent(tab: TerminalTab): TuiAgent | null {
  const focusedHookAgent = useAppStore((s) =>
    resolveFocusedTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const siblingHookAgent = useAppStore((s) =>
    resolveSiblingTabAgent(s.agentStatusByPaneKey, s.terminalLayoutsByTabId[tab.id], tab.id)
  )
  const focusedCompletedHookAgent = useAppStore((s) =>
    resolveFocusedCompletedTabAgent(
      s.agentStatusByPaneKey,
      s.terminalLayoutsByTabId[tab.id],
      tab.id
    )
  )
  const siblingCompletedHookAgent = useAppStore((s) =>
    resolveSiblingCompletedTabAgent(
      s.agentStatusByPaneKey,
      s.terminalLayoutsByTabId[tab.id],
      tab.id
    )
  )
  const completedHookAgent = focusedCompletedHookAgent ?? siblingCompletedHookAgent
  const hasCompletedHook = focusedCompletedHookAgent !== null
  const clearTabLaunchAgent = useAppStore((s) => s.clearTabLaunchAgent)

  const {
    ptyId,
    foregroundPaneKey,
    foregroundLifecycleKey,
    foregroundCommandFinishedEpoch,
    foregroundInterruptEpoch,
    foregroundInputEpoch,
    isRemoteLike
  } = useTabAgentForegroundSignals(tab.id)
  const setForegroundAgentForPane = useAppStore((s) => s.setForegroundAgentForPane)
  const clearForegroundAgentForPane = useAppStore((s) => s.clearForegroundAgentForPane)

  // undefined = no conclusive local reading (defer to title/hook);
  // null = foreground is a shell; TuiAgent = recognized agent process.
  const [foreground, setForeground] = useState<TuiAgent | null | undefined>(undefined)
  const [foregroundObservedCommandEpoch, setForegroundObservedCommandEpoch] = useState(0)
  const [hasObservedAgentSignal, setHasObservedAgentSignal] = useState(false)
  const [shellForegroundAfterAgentSignal, setShellForegroundAfterAgentSignal] = useState(false)
  const [launchShellForegroundExhausted, setLaunchShellForegroundExhausted] = useState(false)
  const hasObservedAgentSignalRef = useRef(false)
  const foregroundRef = useRef<TuiAgent | null | undefined>(undefined)
  const foregroundObservedCommandEpochRef = useRef(0)
  const lastScheduledInterruptRecheckEpochRef = useRef(0)
  const suppressedForegroundCommandEpochRef = useRef(0)
  const titleForegroundKey = getTitleForegroundKey(tab.title, tab.launchAgent)

  useEffect(() => {
    foregroundRef.current = undefined
    foregroundObservedCommandEpochRef.current = 0
    setForeground(undefined)
    setForegroundObservedCommandEpoch(0)
    setHasObservedAgentSignal(false)
    hasObservedAgentSignalRef.current = false
    lastScheduledInterruptRecheckEpochRef.current = 0
    suppressedForegroundCommandEpochRef.current = 0
    setShellForegroundAfterAgentSignal(false)
    setLaunchShellForegroundExhausted(false)
  }, [ptyId, isRemoteLike])

  useEffect(() => {
    suppressedForegroundCommandEpochRef.current = 0
  }, [foregroundInputEpoch])

  useEffect(() => {
    return () => {
      if (foregroundPaneKey) {
        clearForegroundAgentForPane(foregroundPaneKey)
      }
    }
  }, [clearForegroundAgentForPane, foregroundPaneKey, isRemoteLike, ptyId])

  useEffect(() => {
    const fallbackAgentSignal =
      !tab.launchAgent && (resolveExplicitTerminalTitleAgentType(tab.title) || siblingHookAgent)
    // Why: a completed structured hook proves a launched agent existed, but
    // local launch cleanup still waits for current foreground-shell evidence.
    if (focusedHookAgent || hasCompletedHook || fallbackAgentSignal) {
      hasObservedAgentSignalRef.current = true
      setHasObservedAgentSignal(true)
    }
  }, [focusedHookAgent, hasCompletedHook, siblingHookAgent, tab.launchAgent, tab.title])

  useEffect(() => {
    if (!ptyId || isRemoteLike) {
      return
    }
    const localPtyId = ptyId
    let cancelled = false
    const helperForegroundRetryTimers: number[] = []
    // Why: re-runs when ptyId or tab.title changes — a title change is the event
    // signalling a possible foreground transition (agent start, exit, or turn).
    // One RPC per transition, not a timer; cancellation coalesces rapid churn.
    function readForeground(retryIndex = 0): void {
      const commandFinishedEpoch = foregroundPaneKey
        ? (useAppStore.getState().terminalCommandFinishedEpochByPaneKey[foregroundPaneKey] ?? 0)
        : 0
      const interruptInputEpoch = foregroundPaneKey
        ? (useAppStore.getState().terminalInterruptInputEpochByPaneKey[foregroundPaneKey] ?? 0)
        : 0
      window.api.pty
        .getForegroundProcess(localPtyId)
        .then((process) => {
          // Why: a foreground read can resolve after Ctrl+C/OSC 133 D. Do not
          // let that stale pre-exit result repaint the tab as an agent.
          if (
            foregroundPaneKey &&
            ((useAppStore.getState().terminalCommandFinishedEpochByPaneKey[foregroundPaneKey] ??
              0) !== commandFinishedEpoch ||
              (useAppStore.getState().terminalInterruptInputEpochByPaneKey[foregroundPaneKey] ??
                0) !== interruptInputEpoch)
          ) {
            return
          }
          applyForegroundProcess(process, retryIndex, commandFinishedEpoch)
        })
        .catch(() => {
          if (!cancelled) {
            if (foregroundPaneKey) {
              clearForegroundAgentForPane(foregroundPaneKey)
            }
            foregroundRef.current = undefined
            setForeground(undefined)
          }
        })
    }
    function scheduleHelperForegroundRetry(retryIndex: number): void {
      const delay = HELPER_FOREGROUND_RETRY_DELAYS_MS[retryIndex]
      if (delay === undefined) {
        return
      }
      // Why: the daemon resolves shell/helper -> agent ancestry asynchronously
      // after the first foreground read, so give its short cache a bounded re-read.
      const timer = window.setTimeout(() => {
        readForeground(retryIndex + 1)
      }, delay)
      helperForegroundRetryTimers.push(timer)
    }
    function hasHelperForegroundRetry(retryIndex: number): boolean {
      return HELPER_FOREGROUND_RETRY_DELAYS_MS[retryIndex] !== undefined
    }
    function applyForegroundProcess(
      process: string | null,
      retryIndex: number,
      observedCommandFinishedEpoch: number
    ): void {
      if (cancelled) {
        return
      }
      const recognized = recognizeAgentProcess(process)
      if (recognized) {
        const commandFinishedInvalidatedForeground =
          foregroundRef.current !== null &&
          foregroundRef.current !== undefined &&
          observedCommandFinishedEpoch > foregroundObservedCommandEpochRef.current
        const commandEpochIsSuppressed =
          observedCommandFinishedEpoch > 0 &&
          suppressedForegroundCommandEpochRef.current === observedCommandFinishedEpoch
        if (commandFinishedInvalidatedForeground || commandEpochIsSuppressed) {
          // Why: daemon foreground can briefly return the exited agent after
          // OSC 133 command-finished. Keep the tab cleared until shell wins or
          // new terminal input starts a fresh command.
          suppressedForegroundCommandEpochRef.current = observedCommandFinishedEpoch
          foregroundRef.current = null
          foregroundObservedCommandEpochRef.current = observedCommandFinishedEpoch
          setForeground(null)
          setForegroundObservedCommandEpoch(observedCommandFinishedEpoch)
          if (foregroundPaneKey) {
            clearForegroundAgentForPane(foregroundPaneKey)
          }
          scheduleHelperForegroundRetry(retryIndex)
          return
        }
        suppressedForegroundCommandEpochRef.current = 0
        hasObservedAgentSignalRef.current = true
        setHasObservedAgentSignal(true)
        setLaunchShellForegroundExhausted(false)
        foregroundRef.current = recognized.agent
        foregroundObservedCommandEpochRef.current = observedCommandFinishedEpoch
        setForeground(recognized.agent)
        setForegroundObservedCommandEpoch(observedCommandFinishedEpoch)
        if (foregroundPaneKey) {
          setForegroundAgentForPane(foregroundPaneKey, {
            agent: recognized.agent,
            ptyId: localPtyId,
            updatedAt: Date.now()
          })
        }
      } else if (process && isShellProcess(process)) {
        suppressedForegroundCommandEpochRef.current = 0
        foregroundRef.current = null
        foregroundObservedCommandEpochRef.current = observedCommandFinishedEpoch
        setShellForegroundAfterAgentSignal(hasObservedAgentSignalRef.current)
        setForeground(null)
        setForegroundObservedCommandEpoch(observedCommandFinishedEpoch)
        if (foregroundPaneKey) {
          clearForegroundAgentForPane(foregroundPaneKey)
        }
        if (tab.launchAgent && !hasObservedAgentSignalRef.current) {
          // Why: launch intent covers the startup grace window, but after the
          // bounded shell retries are exhausted it becomes stale cancellation
          // evidence, such as Ctrl+C before the TUI ever reached foreground.
          if (!hasHelperForegroundRetry(retryIndex)) {
            setLaunchShellForegroundExhausted(true)
            return
          }
          scheduleHelperForegroundRetry(retryIndex)
        }
      } else {
        if (foregroundPaneKey && hasObservedAgentSignalRef.current) {
          clearForegroundAgentForPane(foregroundPaneKey)
        }
        if (process && tab.launchAgent) {
          // Why: for Orca-owned launches, an unrecognized non-shell process
          // is enough lifecycle evidence to clear launch intent when the pane
          // later returns to a shell, without using title text as identity.
          hasObservedAgentSignalRef.current = true
          setHasObservedAgentSignal(true)
        }
        foregroundRef.current = undefined
        setForeground(undefined)
        if (process && tab.launchAgent) {
          scheduleHelperForegroundRetry(retryIndex)
        }
      }
    }
    readForeground()
    if (
      foregroundInterruptEpoch > 0 &&
      foregroundInterruptEpoch > lastScheduledInterruptRecheckEpochRef.current
    ) {
      lastScheduledInterruptRecheckEpochRef.current = foregroundInterruptEpoch
      for (const delay of INTERRUPT_FOREGROUND_RECHECK_DELAYS_MS) {
        const timer = window.setTimeout(() => {
          readForeground()
        }, delay)
        helperForegroundRetryTimers.push(timer)
      }
    }
    return () => {
      cancelled = true
      helperForegroundRetryTimers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [
    clearForegroundAgentForPane,
    foregroundLifecycleKey,
    foregroundInterruptEpoch,
    foregroundPaneKey,
    isRemoteLike,
    ptyId,
    setForegroundAgentForPane,
    tab.launchAgent,
    titleForegroundKey
  ])

  const commandFinishedAfterForegroundObservation =
    foregroundCommandFinishedEpoch > foregroundObservedCommandEpoch
  const resolvedForeground =
    foreground && commandFinishedAfterForegroundObservation ? null : foreground

  useEffect(() => {
    if (resolvedForeground === null && foregroundPaneKey) {
      clearForegroundAgentForPane(foregroundPaneKey)
    }
    if (!tab.launchAgent) {
      return
    }
    const titleLooksShell = isShellProcess(tab.title)
    const foregroundSawExitedAgent =
      !isRemoteLike && resolvedForeground === null && shellForegroundAfterAgentSignal
    const foregroundStayedShellThroughStartup =
      !isRemoteLike && resolvedForeground === null && launchShellForegroundExhausted
    const remoteHookCompletedAtShellTitle = isRemoteLike && hasCompletedHook && titleLooksShell
    if (
      foregroundSawExitedAgent ||
      foregroundStayedShellThroughStartup ||
      remoteHookCompletedAtShellTitle
    ) {
      clearTabLaunchAgent(tab.id)
    }
  }, [
    clearForegroundAgentForPane,
    clearTabLaunchAgent,
    resolvedForeground,
    foregroundPaneKey,
    hasCompletedHook,
    isRemoteLike,
    launchShellForegroundExhausted,
    shellForegroundAfterAgentSignal,
    tab.id,
    tab.launchAgent,
    tab.title
  ])

  return resolveTabAgentFromSignals({
    foreground: resolvedForeground,
    hasObservedAgentSignal,
    launchShellForegroundExhausted,
    shellForegroundAfterAgentSignal,
    isRemote: isRemoteLike,
    title: tab.title,
    hookAgent: focusedHookAgent,
    siblingHookAgent,
    hasCompletedHook,
    completedHookAgent,
    launchAgent: tab.launchAgent
  })
}
