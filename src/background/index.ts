import { loadStore } from '../group/store'
import type { GroupChat, GroupRole, OpenTeamStore } from '../group/types'
import { createChatHandlers } from './chatHandlers'
import { createMessageHandlers } from './messageHandlers'
import {
  broadcastStoreUpdated as broadcastRuntimeStoreUpdated,
  forgetHostTab,
  listHostTabIds,
  rememberHost,
  sendError,
  type RuntimeMessage,
} from './runtimeClient'
import { createMessageRouter } from './messageRouter'
import { createPromptSender } from './promptDelivery'
import { createRoleHandlers } from './roleHandlers'
import { createRuntimeFrameRegistry } from './runtimeFrames'
import { getChatMessages, getChatRoles, mutateStore } from './storeAccess'

const runtimeFrames = createRuntimeFrameRegistry()

const log = {
  debug(event: string, details?: Record<string, unknown>): void {
    console.debug('[OpenTeam][background]', event, details || {})
  },
  info(event: string, details?: Record<string, unknown>): void {
    console.info('[OpenTeam][background]', event, details || {})
  },
  warn(event: string, details?: Record<string, unknown>): void {
    console.warn('[OpenTeam][background]', event, details || {})
  },
  error(event: string, details?: Record<string, unknown>): void {
    console.error('[OpenTeam][background]', event, details || {})
  },
}

const sendPrompt = createPromptSender({ log })

function now(): number {
  return Date.now()
}

function newId(prefix: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  return `${prefix}-${cryptoApi?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

async function broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> {
  await broadcastRuntimeStoreUpdated(store, { excludeTabId, legacyState: toLegacyState(store) })
}

function getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status'] {
  const roles = getChatRoles(store, chat)
  if (roles.length === 0) return 'draft'
  if (roles.some(role => role.status === 'thinking' || role.status === 'loading')) return 'running'
  if (roles.some(role => role.status === 'error')) return 'error'
  return 'ready'
}

async function handleStoreGet(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  rememberHost(sender, message.hostTabId)
  const store = await loadStore()
  return { ok: true, store, state: toLegacyState(store), bindings: runtimeFrames.list() }
}

async function handleSettingsUpdate(message: RuntimeMessage) {
  const { store } = await mutateStore(store => {
    const defaultChatSite = readOptionalString(message.defaultChatSite)
    if (defaultChatSite === 'chatgpt' || defaultChatSite === 'gemini' || defaultChatSite === 'claude') {
      store.settings.defaultChatSite = defaultChatSite
    }
  })
  await broadcastStoreUpdated(store)
  return { ok: true, store }
}

function toLegacyState(store: OpenTeamStore) {
  const chat = store.currentChatId ? store.chatsById[store.currentChatId] : undefined
  const roles = chat ? getChatRoles(store, chat).map(role => ({
    id: role.id,
    name: role.name,
    tabId: runtimeFrames.getByRole(chat.id, role.id)?.tabId ?? -1,
    frameId: runtimeFrames.getByRole(chat.id, role.id)?.frameId,
    conversationId: role.geminiConversationId ?? '__default__',
    status: legacyStatus(role.status),
    createdAt: role.createdAt,
    lastMessageAt: role.lastReplyAt,
  })) : []
  const messages = chat ? getChatMessages(store, chat).map(message => ({
    id: message.id,
    roomId: chat.id,
    roleId: message.roleId,
    roleName: message.roleName,
    from: message.type === 'assistant' ? 'role' : message.type,
    target: message.targetRoleIds && message.targetRoleIds.length > 0 ? message.targetRoleIds.length === roles.length ? 'all' : 'role' : 'none',
    targetRoleName: message.targetRoleIds?.length === 1 ? store.rolesById[message.targetRoleIds[0]]?.name : undefined,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status,
  })) : []

  return { roomId: chat?.id ?? 'group-empty', hostTabId: listHostTabIds()[0] ?? -1, roles, messages }
}

function legacyStatus(status: GroupRole['status']): string {
  if (status === 'pending' || status === 'loading') return 'opening'
  if (status === 'ready') return 'idle'
  if (status === 'thinking') return 'generating'
  return 'error'
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

async function handleLegacyHostReady(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  rememberHost(sender, message.hostTabId)
  const store = await loadStore()
  return { ok: true, store, state: toLegacyState(store) }
}

async function handleLegacyCreateRole(message: RuntimeMessage) {
  const store = await loadStore()
  let chatId = store.currentChatId
  if (!chatId) {
    const created = await routeMessage({ type: 'GROUP_CHAT_CREATE', name: 'OpenTeam', mode: 'independent' }, {}) as { chat: GroupChat }
    chatId = created.chat.id
  }

  return routeMessage({ type: 'GROUP_ROLE_CREATE', chatId, name: message.name }, {})
}

const routeMessage = createMessageRouter([
  { type: 'GROUP_STORE_GET', handler: handleStoreGet },
  ...createChatHandlers({ broadcastStoreUpdated, getChatStatusFromRoles, log, newId, now, runtimeFrames }),
  { type: 'GROUP_SETTINGS_UPDATE', handler: handleSettingsUpdate },
  ...createRoleHandlers({ broadcastStoreUpdated, log, newId, now, runtimeFrames, sendPrompt }),
  ...createMessageHandlers({ broadcastStoreUpdated, getChatStatusFromRoles, log, newId, now, runtimeFrames, sendError, sendPrompt }),
  { type: 'TEAM_HOST_READY', handler: handleLegacyHostReady },
  { type: 'TEAM_GET_STATE', handler: handleLegacyHostReady },
  { type: 'TEAM_CREATE_ROLE', handler: handleLegacyCreateRole },
  {
    type: 'TEAM_SEND_MESSAGE',
    handler: async message => {
      const store = await loadStore()
      if (!store.currentChatId) return { ok: false, error: '请先创建群聊' }
      return routeMessage({ type: 'GROUP_MESSAGE_SEND', chatId: store.currentChatId, raw: message.raw }, {})
    },
  },
])

chrome.runtime.onInstalled.addListener(() => {
  log.info('extension-installed')
})

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  if (message?.type === 'OPENTEAM_PING') {
    sendResponse({ ok: true, tabId: sender.tab?.id ?? null })
    return true
  }

  Promise.resolve(routeMessage(message, sender))
    .then(sendResponse)
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      log.error('message-handler:failed', { type: message?.type, error: reason })
      sendError(reason).catch(() => undefined)
      sendResponse({ ok: false, error: reason })
    })

  return true
})

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('team.html'), active: true }).catch(error => {
    log.warn('open-team-page:failed', { error: error instanceof Error ? error.message : String(error) })
  })
})

chrome.tabs.onRemoved.addListener(tabId => {
  forgetHostTab(tabId)
  const removed = runtimeFrames.removeTab(tabId)
  if (removed.length === 0) return

  mutateStore(store => {
    const timestamp = now()
    for (const binding of removed) {
      const role = store.rolesById[binding.roleId]
      if (!role || role.chatId !== binding.chatId || role.status === 'thinking') continue
      role.status = 'loading'
      role.updatedAt = timestamp
    }
  })
    .then(({ store }) => broadcastStoreUpdated(store))
    .catch(error => log.warn('tab-removed:update-failed', { tabId, error: error instanceof Error ? error.message : String(error) }))
})
