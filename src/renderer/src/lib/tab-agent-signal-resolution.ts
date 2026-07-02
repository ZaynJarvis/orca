import { isShellProcess } from '../../../shared/agent-detection'
import type { TuiAgent } from '../../../shared/types'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'

export { resolveExplicitTerminalTitleAgentType as resolveTabAgentFromTitle } from '../../../shared/terminal-title-agent-type'

export function resolveTabAgentFromSignals(args: {
  foreground: TuiAgent | null | undefined
  hasObservedAgentSignal: boolean
  launchShellForegroundExhausted?: boolean
  shellForegroundAfterAgentSignal: boolean
  isRemote: boolean
  title: string
  hookAgent: TuiAgent | null
  siblingHookAgent?: TuiAgent | null
  hasCompletedHook: boolean
  completedHookAgent?: TuiAgent | null
  launchAgent?: TuiAgent
}): TuiAgent | null {
  const explicitTitleAgent = resolveExplicitTerminalTitleAgentType(args.title)
  const titleAgent = explicitTitleAgent
  const titleLooksShell = isShellProcess(args.title)
  // Why: remote panes cannot cheaply prove shell foreground after hook exit,
  // so keep the last completed hook identity instead of flashing unknown.
  const completedHookAgent =
    !args.isRemote && titleLooksShell && args.hasCompletedHook ? null : args.completedHookAgent
  const focusedHookAgent = args.hookAgent ?? null
  const fallbackHookAgent = args.siblingHookAgent ?? completedHookAgent ?? null
  // Why: launch metadata is only startup intent. The visible tab icon should
  // come from observed evidence: foreground process, hooks, or explicit titles.
  if (args.isRemote || args.foreground === undefined) {
    return focusedHookAgent ?? titleAgent ?? fallbackHookAgent
  }
  if (args.foreground) {
    return args.foreground
  }
  // Why: once a local pane has returned to a shell, stale metadata should not
  // keep painting it as an agent tab.
  if (args.shellForegroundAfterAgentSignal || args.launchShellForegroundExhausted) {
    return null
  }
  return focusedHookAgent ?? titleAgent ?? fallbackHookAgent
}
