import type { RoleToBackgroundMessage, RuntimeRoleStatus, type ReplyFailureReason } from '../group/runtimeProtocol'

export function promptStatusMessage(
  status: RuntimeRoleStatus,
  chatId: string,
  roleId: string,
  error?: string | ReplyFailureReason,
): Extract<RoleToBackgroundMessage, { type: 'TEAM_ROLE_STATUS' }> {
  return {
    type: 'TEAM_ROLE_STATUS',
    status,
    chatId,
    roleId,
    ...(error ? { error } : {}),
  }
}
