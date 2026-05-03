import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'

describe('background role handlers', () => {
  it('exposes template and role routes and creates a role template through injected dependencies', async () => {
    vi.resetModules()
    let draftStore: OpenTeamStore | undefined
    vi.doMock('./storeAccess', async importOriginal => {
      const actual = await importOriginal<typeof import('./storeAccess')>()
      return {
        ...actual,
        mutateStore: vi.fn(async (mutator: (store: OpenTeamStore) => unknown) => {
          const store = createDefaultStore()
          const result = await mutator(store)
          draftStore = store
          return { store, result }
        }),
      }
    })

    const { ROLE_ROUTE_TYPES, createRoleHandlers } = await import('./roleHandlers')
    const broadcastStoreUpdated = vi.fn()
    const routes = createRoleHandlers({
      broadcastStoreUpdated,
      log: { info: vi.fn(), warn: vi.fn() },
      newId: vi.fn((prefix: string) => `${prefix}-1`),
      now: vi.fn(() => 100),
      runtimeFrames: {
        getByRole: vi.fn(),
        removeRole: vi.fn(),
      },
      sendPrompt: vi.fn(),
    })

    expect(ROLE_ROUTE_TYPES).toEqual([
      'ROLE_TEMPLATE_CREATE',
      'ROLE_TEMPLATE_UPDATE',
      'ROLE_TEMPLATE_DELETE',
      'GROUP_ROLE_CREATE',
      'GROUP_ROLES_CREATE_BATCH',
      'GROUP_ROLE_UPDATE',
      'GROUP_ROLE_DELETE',
      'GROUP_ROLE_RECOVER',
      'GROUP_ROLE_REINITIALIZE',
    ])
    expect(routes.map(route => route.type)).toEqual(ROLE_ROUTE_TYPES)

    const createTemplateRoute = routes.find(route => route.type === 'ROLE_TEMPLATE_CREATE')
    const response = await createTemplateRoute?.handler({
      type: 'ROLE_TEMPLATE_CREATE',
      name: '工程师',
      systemPrompt: '从工程角度分析',
      defaultChatSite: 'chatgpt',
    }, {})

    expect(response).toMatchObject({
      ok: true,
      template: {
        id: 'template-1',
        name: '工程师',
        systemPrompt: '从工程角度分析',
        defaultChatSite: 'chatgpt',
      },
    })
    expect(draftStore?.roleTemplateOrder).toEqual(['template-1'])
    expect(broadcastStoreUpdated).toHaveBeenCalledWith(expect.objectContaining({
      roleTemplatesById: expect.objectContaining({ 'template-1': expect.any(Object) }),
    }))
  })
})
