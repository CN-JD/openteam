import type { GroupChat, GroupRole, OpenTeamStore } from '../group/types'
import type { RoleReadyWaiter, TeamPageState } from './appState'
import { shouldAutoReconnectRole } from './chatExperience'

const AUTO_RECONNECT_TIMEOUT_MS = 90_000
const ROLE_READY_POLL_MS = 1_000

interface RoleRecoveryIframeHost {
  focusRoleFrame(chatId: string, roleId: string): boolean
  recoverRole(role: GroupRole): void
}

export interface RoleRecoveryDependencies {
  state: TeamPageState
  getStore(): OpenTeamStore
  getCurrentRoles(): GroupRole[]
  refreshStore(showFailure?: boolean): Promise<void>
  switchChat(chatId: string): void
  renderComposerState(): void
  setWindowMinimized(minimized: boolean): void
  iframeHost: RoleRecoveryIframeHost
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
  log: {
    info(event: string, details?: Record<string, unknown>): void
  }
}

export interface RoleRecoveryController {
  focusRoleFrame(chatId: string, roleId: string | undefined): void
  notifyRoleReadyWaiters(): void
  reconnectRolesForSend(chat: GroupChat, roles: GroupRole[]): Promise<void>
  refreshCurrentChat(): Promise<void>
  retryRoleReply(role: GroupRole): Promise<void>
  stopRoleReply(role: GroupRole): Promise<void>
}

export function createRoleRecoveryController(deps: RoleRecoveryDependencies): RoleRecoveryController {
  async function refreshCurrentChat(): Promise<void> {
    await deps.refreshStore()
    const store = deps.getStore()
    const chat = deps.state.selectedChatId ? store.chatsById[deps.state.selectedChatId] : undefined
    if (!chat) return

    const reconnectableRoles = deps.getCurrentRoles().filter(role => role.status !== 'ready' && shouldAutoReconnectRole(role))
    if (reconnectableRoles.length === 0) return

    deps.log.info('ui:refresh-recover-chat', { chatId: chat.id, roleIds: reconnectableRoles.map(role => role.id) })
    await reconnectRolesForSend(chat, reconnectableRoles)
    await deps.refreshStore(false)
  }

  function areRolesReady(chatId: string, roleIds: string[]): boolean {
    const store = deps.getStore()
    return roleIds.every(roleId => {
      const role = store.rolesById[roleId]
      return role?.chatId === chatId && role.status === 'ready'
    })
  }

  function notifyRoleReadyWaiters(): void {
    for (const waiter of [...deps.state.roleReadyWaiters]) {
      if (!areRolesReady(waiter.chatId, [...waiter.roleIds])) continue
      waiter.resolve()
    }
  }

  function waitForRolesReady(chatId: string, roleIds: string[], timeoutMs = AUTO_RECONNECT_TIMEOUT_MS): Promise<void> {
    const uniqueRoleIds = [...new Set(roleIds)]
    if (areRolesReady(chatId, uniqueRoleIds)) return Promise.resolve()

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(waiter.timeoutId)
        if (waiter.pollTimeoutId !== undefined) window.clearTimeout(waiter.pollTimeoutId)
        deps.state.roleReadyWaiters.delete(waiter)
      }
      const resolveReady = () => {
        cleanup()
        resolve()
      }
      const rejectTimeout = () => {
        cleanup()
        reject(new Error(`等待人员恢复超时：${roleLabels(chatId, uniqueRoleIds).join('、')}`))
      }
      const schedulePoll = () => {
        waiter.pollTimeoutId = window.setTimeout(() => {
          deps.refreshStore(false)
            .then(() => {
              if (areRolesReady(chatId, uniqueRoleIds)) {
                resolveReady()
                return
              }
              schedulePoll()
            })
            .catch(() => schedulePoll())
        }, ROLE_READY_POLL_MS)
      }
      const waiter: RoleReadyWaiter = {
        chatId,
        roleIds: new Set(uniqueRoleIds),
        resolve: resolveReady,
        reject,
        timeoutId: window.setTimeout(rejectTimeout, timeoutMs),
      }
      deps.state.roleReadyWaiters.add(waiter)
      schedulePoll()
    })
  }

  async function reconnectRolesForSend(chat: GroupChat, roles: GroupRole[]): Promise<void> {
    const uniqueRoles = [...new Map(roles.map(role => [role.id, role])).values()]
    if (uniqueRoles.length === 0) return

    for (const role of uniqueRoles) deps.state.reconnectingRoleKeys.add(teamRoleKey(chat.id, role.id))
    deps.renderComposerState()

    try {
      deps.log.info('roles:auto-reconnect:start', { chatId: chat.id, roleIds: uniqueRoles.map(role => role.id) })
      await Promise.all(uniqueRoles.map(role => deps.runCommand('GROUP_ROLE_RECOVER', { chatId: chat.id, roleId: role.id })))
      for (const role of uniqueRoles) deps.iframeHost.recoverRole(role)
      await waitForRolesReady(chat.id, uniqueRoles.map(role => role.id))
      deps.log.info('roles:auto-reconnect:ready', { chatId: chat.id, roleIds: uniqueRoles.map(role => role.id) })
    } finally {
      for (const role of uniqueRoles) deps.state.reconnectingRoleKeys.delete(teamRoleKey(chat.id, role.id))
      deps.renderComposerState()
    }
  }

  function focusRoleFrame(chatId: string, roleId: string | undefined): void {
    if (!roleId) return
    deps.setWindowMinimized(true)
    const store = deps.getStore()
    const chat = store.chatsById[chatId]
    if (chat && deps.state.selectedChatId !== chatId) deps.switchChat(chatId)
    if (deps.iframeHost.focusRoleFrame(chatId, roleId)) return
    const role = store.rolesById[roleId]
    if (!role) return
    deps.iframeHost.recoverRole(role)
  }

  async function stopRoleReply(role: GroupRole): Promise<void> {
    const chat = deps.getStore().chatsById[role.chatId]
    if (!chat) return
    await deps.runCommand('GROUP_ROLE_STOP_REPLY', { chatId: chat.id, roleId: role.id })
    await deps.refreshStore(false)
  }

  async function retryRoleReply(role: GroupRole): Promise<void> {
    const chat = deps.getStore().chatsById[role.chatId]
    if (!chat) return
    await deps.runCommand('GROUP_ROLE_RETRY_REPLY', { chatId: chat.id, roleId: role.id, messageId: role.lastPromptMessageId })
    await deps.refreshStore(false)
  }

  return { focusRoleFrame, notifyRoleReadyWaiters, reconnectRolesForSend, refreshCurrentChat, retryRoleReply, stopRoleReply }

  function roleLabels(chatId: string, roleIds: string[]): string[] {
    const store = deps.getStore()
    return roleIds.map(roleId => {
      const role = store.rolesById[roleId]
      return role?.chatId === chatId && role.name.trim() ? role.name : roleId
    })
  }
}

function teamRoleKey(chatId: string, roleId: string): string {
  return `${chatId}:${roleId}`
}
