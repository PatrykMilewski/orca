import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { getNativeChatSessionTransport } from '@/components/native-chat/native-chat-session-transport'
import type { AppState } from '@/store/types'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

const TRANSCRIPT_ANCHOR_READ_LIMIT = 40

type PromptCacheTranscriptSource = {
  sessionId: string
  transcriptPath?: string
  worktreeId: string
}

/**
 * Newest conversation record, which bounds the last API request from below. A prompt
 * or tool result is sent the moment it is written, so it still anchors correctly when
 * the countdown starts before the reply is flushed. Interruption notices are not sent.
 */
export function lastRequestTimestamp(messages: readonly NativeChatMessage[]): number | null {
  let latest: number | null = null
  for (const message of messages) {
    if (message.role !== 'system' && message.timestamp !== null) {
      latest = latest === null ? message.timestamp : Math.max(latest, message.timestamp)
    }
  }
  return latest
}

function findWorktreeIdForTab(state: AppState, tabId: string): string | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

/**
 * The Claude session a pane's countdown belongs to, when its transcript is readable
 * through the native chat transport. SSH relay panes are skipped: their transcript
 * lives on the remote machine, and a same-path local file is not that session.
 */
export function resolvePromptCacheTranscriptSource(
  state: AppState,
  paneKey: string
): PromptCacheTranscriptSource | null {
  const tabId = parsePaneKey(paneKey)?.tabId
  if (!tabId) {
    return null
  }
  const row = state.agentStatusByPaneKey[paneKey]
  if (row?.agentType === 'claude' && row.providerSession?.key === 'session_id') {
    const worktreeId = row.worktreeId ?? findWorktreeIdForTab(state, tabId)
    if ((row.connectionId ?? null) !== null || !worktreeId) {
      return null
    }
    return {
      sessionId: row.providerSession.id,
      ...(row.providerSession.transcriptPath
        ? { transcriptPath: row.providerSession.transcriptPath }
        : {}),
      worktreeId
    }
  }
  // Why: after a restart the persisted sleep checkpoint names the session before
  // the hook server has republished the pane's row.
  const record = state.sleepingAgentSessionsByPaneKey[paneKey]
  if (
    record?.agent !== 'claude' ||
    record.providerSession.key !== 'session_id' ||
    (record.connectionId ?? null) !== null
  ) {
    return null
  }
  return {
    sessionId: record.providerSession.id,
    ...(record.providerSession.transcriptPath
      ? { transcriptPath: record.providerSession.transcriptPath }
      : {}),
    worktreeId: record.worktreeId
  }
}

/**
 * Moves a freshly started countdown back to the session's last API request.
 * Sleep, restart, and `--resume` start the countdown without a request, so the
 * cache is older than the countdown claims. Only ever moves the start earlier.
 */
export async function anchorPromptCacheTimerToTranscript(args: {
  paneKey: string
  startedAt: number
  getState: () => AppState
  applyAnchor: (anchoredAt: number) => void
}): Promise<void> {
  const state = args.getState()
  const source = resolvePromptCacheTranscriptSource(state, args.paneKey)
  if (!source) {
    return
  }
  const transport = getNativeChatSessionTransport(
    getRuntimeEnvironmentIdForWorktree(state, source.worktreeId)
  )
  let anchoredAt: number | null
  try {
    const result = await transport.readSession(
      'claude',
      source.sessionId,
      TRANSCRIPT_ANCHOR_READ_LIMIT,
      source.transcriptPath
    )
    if ('error' in result) {
      return
    }
    anchoredAt = lastRequestTimestamp(result.messages)
  } catch {
    return
  }
  if (anchoredAt === null || anchoredAt >= args.startedAt) {
    return
  }
  // Why: a new turn or pane exit during the read owns the countdown now.
  if (args.getState().cacheTimerByKey[args.paneKey] !== args.startedAt) {
    return
  }
  args.applyAnchor(anchoredAt)
}
