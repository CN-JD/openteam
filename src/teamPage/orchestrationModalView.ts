import type { GroupChat, GroupRole, OpenTeamStore, OrchestrationFlow, OrchestrationGraphSnapshot, OrchestrationStage } from '../group/types'
import { DEFAULT_ORCHESTRATION_MAX_ROUNDS, MAX_ORCHESTRATION_MAX_ROUNDS } from '../group/types'
import { createOrchestrationCanvas, type LoadX6, type OrchestrationCanvas } from './orchestrationCanvas'

export interface OrchestrationModalDependencies {
  openOrchestrationEl: HTMLButtonElement
  orchestrationModalEl: HTMLElement
  closeOrchestrationEl: HTMLButtonElement
  orchestrationTaskEl: HTMLTextAreaElement
  orchestrationPeopleListEl: HTMLElement
  orchestrationCanvasEl: HTMLElement
  orchestrationHintEl: HTMLElement
  orchestrationStageSettingsEl: HTMLElement
  orchestrationReviewSettingsEl: HTMLElement
  orchestrationMaxRoundsEl: HTMLInputElement
  saveOrchestrationEl: HTMLButtonElement
  runOrchestrationEl: HTMLButtonElement
  getStore(): OpenTeamStore
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  reconnectRolesForSend(chat: GroupChat, roles: GroupRole[]): Promise<void>
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
  showSuccess(message: string): void
  loadX6?: LoadX6
}

export interface OrchestrationModalView {
  close(): void
  render(): void
  registerOrchestrationEvents(): void
}

interface FlowDraft {
  flowId?: string
  task: string
  stages: OrchestrationStage[]
  graphEdges: OrchestrationGraphSnapshot['edges']
  maxRounds: number
  selectedStageId?: string
}

export function createOrchestrationModalView(deps: OrchestrationModalDependencies): OrchestrationModalView {
  let draft: FlowDraft = emptyDraft()
  let canvas: OrchestrationCanvas | undefined
  let mounted = false

  function emptyDraft(): FlowDraft {
    return { task: '', stages: [], graphEdges: [], maxRounds: DEFAULT_ORCHESTRATION_MAX_ROUNDS }
  }

  function open(): void {
    const chat = deps.getCurrentChat()
    if (!chat) {
      deps.showError('请选择群聊后再编排任务')
      return
    }
    loadDraft(chat)
    deps.orchestrationModalEl.hidden = false
    deps.orchestrationTaskEl.value = draft.task
    deps.orchestrationMaxRoundsEl.value = String(draft.maxRounds)
    deps.orchestrationMaxRoundsEl.max = String(MAX_ORCHESTRATION_MAX_ROUNDS)
    mountCanvas()
    render()
    deps.orchestrationTaskEl.focus()
  }

  function close(): void {
    deps.orchestrationModalEl.hidden = true
    canvas?.destroy()
    canvas = undefined
    mounted = false
    draft = emptyDraft()
  }

  function loadDraft(chat: GroupChat): void {
    const store = deps.getStore()
    const flowId = store.orchestrationFlowOrderByChatId[chat.id]?.[0]
    const flow = flowId ? store.orchestrationFlowsById[flowId] : undefined
    if (!flow) {
      draft = emptyDraft()
      return
    }
    const stages = cloneStages(flow.graph?.stageNodes?.length ? flow.graph.stageNodes : flow.stages)
    draft = {
      flowId: flow.id,
      task: flow.description?.trim() ?? '',
      stages,
      graphEdges: flow.graph?.edges ? cloneGraphEdges(flow.graph.edges) : sequentialGraphEdges(stages),
      maxRounds: clampMaxRounds(flow.maxRounds),
      selectedStageId: stages[0]?.id,
    }
  }

  function mountCanvas(): void {
    canvas?.destroy()
    canvas = createOrchestrationCanvas({
      rootEl: deps.orchestrationCanvasEl,
      getRoleName,
      onStageSelected(stageId) {
        draft.selectedStageId = stageId
        render()
      },
      onRoleDropped(roleId, targetStageId) {
        if (targetStageId) addRoleToStage(roleId, targetStageId)
        else addRoleAsStage(roleId)
      },
      onGraphChanged(edges) {
        draft.graphEdges = cloneGraphEdges(edges)
      },
      loadX6: deps.loadX6,
    })
    canvas.mount(draft.stages, draft.selectedStageId, draft.graphEdges).then(() => {
      mounted = true
    }).catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  function render(): void {
    if (deps.orchestrationModalEl.hidden) return
    draft.maxRounds = clampMaxRounds(Number(deps.orchestrationMaxRoundsEl.value || DEFAULT_ORCHESTRATION_MAX_ROUNDS))
    deps.orchestrationHintEl.hidden = draft.stages.length > 0
    deps.orchestrationHintEl.textContent = '从左侧添加人员，串联阶段；同一阶段内多人并行执行。'
    renderPeopleList()
    renderStageSettings()
    if (mounted) canvas?.render(draft.stages, draft.selectedStageId, draft.graphEdges)
  }

  function renderPeopleList(): void {
    const roles = deps.getCurrentRoles()
    deps.orchestrationPeopleListEl.replaceChildren()
    if (roles.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty-card compact'
      empty.textContent = '当前群聊暂无人员，无法编排任务。'
      deps.orchestrationPeopleListEl.append(empty)
      return
    }
    for (const role of roles) {
      const card = document.createElement('div')
      card.className = 'orchestration-person'
      card.draggable = true
      card.addEventListener('dragstart', event => {
        event.dataTransfer?.setData('application/x-openteam-role-id', role.id)
      })
      const avatar = document.createElement('span')
      avatar.className = `orchestration-person-avatar ${roleToneClass(role.id)}`
      avatar.textContent = roleInitial(role.name)
      const body = document.createElement('div')
      body.className = 'orchestration-person-body'
      const name = document.createElement('strong')
      name.textContent = role.name
      const description = document.createElement('span')
      description.className = 'tiny'
      description.textContent = role.description || '拖到画布或添加到阶段'
      const actions = document.createElement('div')
      actions.className = 'orchestration-person-actions'
      const addStage = document.createElement('button')
      addStage.className = 'btn btn-ghost'
      addStage.type = 'button'
      addStage.textContent = '新阶段'
      addStage.addEventListener('click', () => addRoleAsStage(role.id))
      const addParallel = document.createElement('button')
      addParallel.className = 'btn btn-ghost'
      addParallel.type = 'button'
      addParallel.textContent = '并行加入'
      addParallel.disabled = !selectedRolesStage()
      addParallel.addEventListener('click', () => addRoleToSelectedStage(role.id))
      const review = document.createElement('button')
      review.className = 'btn btn-ghost'
      review.type = 'button'
      review.textContent = '设为审核'
      review.addEventListener('click', () => setReviewStage(role.id))
      actions.append(addStage, addParallel, review)
      body.append(name, description, actions)
      card.append(avatar, body)
      deps.orchestrationPeopleListEl.append(card)
    }
  }

  function renderStageSettings(): void {
    const selected = selectedStage()
    deps.orchestrationStageSettingsEl.replaceChildren()
    deps.orchestrationReviewSettingsEl.replaceChildren()
    if (!selected) {
      deps.orchestrationStageSettingsEl.append(settingsNote('选择一个阶段后可编辑名称、人员或审核标准。'))
      return
    }

    const title = document.createElement('h3')
    title.textContent = selected.kind === 'review' ? '审核阶段' : '执行阶段'
    const nameField = document.createElement('label')
    nameField.className = 'field'
    nameField.textContent = '阶段名称'
    const nameInput = document.createElement('input')
    nameInput.value = selected.name
    nameInput.addEventListener('input', () => {
      selected.name = nameInput.value.trim() || (selected.kind === 'review' ? '审核' : '执行阶段')
      canvas?.render(draft.stages, draft.selectedStageId, draft.graphEdges)
    })
    nameField.append(nameInput)
    const roles = document.createElement('div')
    roles.className = 'stage-role-chips'
    for (const roleId of selected.roleIds) roles.append(roleChip(roleId, selected))
    const remove = document.createElement('button')
    remove.className = 'btn btn-danger'
    remove.type = 'button'
    remove.textContent = '删除阶段'
    remove.addEventListener('click', () => removeStage(selected.id))
    deps.orchestrationStageSettingsEl.append(title, nameField, roles, remove)

    if (selected.kind === 'review') renderReviewSettings(selected)
  }

  function renderReviewSettings(stage: OrchestrationStage): void {
    const intro = settingsNote('审核阶段是最终阶段，由一个群聊人员根据标准判断通过、继续或停止。')
    const reviewerField = document.createElement('label')
    reviewerField.className = 'field'
    reviewerField.textContent = '审核人员'
    const reviewerSelect = document.createElement('select')
    reviewerSelect.append(new Option('选择审核人员', ''))
    for (const role of deps.getCurrentRoles()) reviewerSelect.append(new Option(role.name, role.id))
    reviewerSelect.value = stage.review?.reviewerRoleIds[0] ?? stage.roleIds[0] ?? ''
    reviewerSelect.addEventListener('change', () => {
      stage.roleIds = reviewerSelect.value ? [reviewerSelect.value] : []
      stage.review = { reviewerRoleIds: stage.roleIds, instructions: stage.review?.instructions ?? '' }
      canvas?.render(draft.stages, draft.selectedStageId, draft.graphEdges)
    })
    reviewerField.append(reviewerSelect)

    const criteriaField = document.createElement('label')
    criteriaField.className = 'field'
    criteriaField.textContent = '审核标准'
    const criteria = document.createElement('textarea')
    criteria.value = stage.review?.instructions ?? ''
    criteria.placeholder = '例如：答案需要覆盖风险、方案和下一步行动。未满足时返回 continue。'
    criteria.addEventListener('input', () => {
      stage.review = { reviewerRoleIds: stage.roleIds, instructions: criteria.value }
    })
    criteriaField.append(criteria)
    const preview = document.createElement('div')
    preview.className = 'orchestration-json-preview'
    const previewTitle = document.createElement('span')
    previewTitle.className = 'tiny'
    previewTitle.textContent = '审核返回 JSON 预览'
    const schema = document.createElement('pre')
    schema.textContent = '{\n  "decision": "pass | continue | stop",\n  "reason": "审核说明",\n  "failedCriteria": [],\n  "nextRoundInstruction": "需要继续时的补充任务"\n}'
    preview.append(previewTitle, schema)
    deps.orchestrationReviewSettingsEl.append(intro, reviewerField, criteriaField, preview)
  }

  function settingsNote(message: string): HTMLElement {
    const note = document.createElement('p')
    note.className = 'tiny orchestration-note'
    note.textContent = message
    return note
  }

  function roleChip(roleId: string, stage: OrchestrationStage): HTMLElement {
    const chip = document.createElement('span')
    chip.className = 'stage-role-chip'
    chip.textContent = getRoleName(roleId)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.setAttribute('aria-label', `移除 ${getRoleName(roleId)}`)
    remove.textContent = '×'
    remove.addEventListener('click', () => {
      stage.roleIds = stage.roleIds.filter(id => id !== roleId)
      if (stage.kind === 'review') stage.review = { reviewerRoleIds: stage.roleIds, instructions: stage.review?.instructions ?? '' }
      render()
    })
    chip.append(remove)
    return chip
  }

  function addRoleToSelectedStage(roleId: string): void {
    const target = selectedRolesStage()
    if (!target) return
    addRoleToStage(roleId, target.id)
  }

  function addRoleToStage(roleId: string, targetStageId: string): void {
    const target = draft.stages.find(stage => stage.id === targetStageId && stage.kind === 'roles')
    if (!target) return
    if (!target.roleIds.includes(roleId)) target.roleIds.push(roleId)
    draft.selectedStageId = target.id
    render()
  }

  function addRoleAsStage(roleId: string): void {
    const sourceStageId = draft.selectedStageId ?? draft.stages[draft.stages.length - 1]?.id
    const stage: OrchestrationStage = { id: newId('stage'), kind: 'roles', name: `阶段 ${draft.stages.filter(item => item.kind === 'roles').length + 1}`, roleIds: [roleId] }
    const reviewIndex = draft.stages.findIndex(item => item.kind === 'review')
    if (reviewIndex >= 0) draft.stages.splice(reviewIndex, 0, stage)
    else draft.stages.push(stage)
    if (sourceStageId && sourceStageId !== stage.id) appendGraphEdge(sourceStageId, stage.id)
    draft.selectedStageId = stage.id
    render()
  }

  function setReviewStage(roleId: string): void {
    const existing = draft.stages.find(stage => stage.kind === 'review')
    if (existing) {
      existing.roleIds = [roleId]
      existing.review = { reviewerRoleIds: [roleId], instructions: existing.review?.instructions ?? '' }
      draft.selectedStageId = existing.id
    } else {
      const stage: OrchestrationStage = { id: newId('review'), kind: 'review', name: '审核', roleIds: [roleId], review: { reviewerRoleIds: [roleId], instructions: '' } }
      const sourceStageId = draft.selectedStageId ?? draft.stages[draft.stages.length - 1]?.id
      draft.stages.push(stage)
      if (sourceStageId) appendGraphEdge(sourceStageId, stage.id)
      draft.selectedStageId = stage.id
    }
    render()
  }

  function appendGraphEdge(sourceStageId: string, targetStageId: string): void {
    if (sourceStageId === targetStageId) return
    if (draft.graphEdges.some(edge => edge.sourceStageId === sourceStageId && edge.targetStageId === targetStageId)) return
    draft.graphEdges.push({ sourceStageId, targetStageId })
  }

  function removeStage(stageId: string): void {
    draft.stages = draft.stages.filter(stage => stage.id !== stageId)
    draft.graphEdges = draft.graphEdges.filter(edge => edge.sourceStageId !== stageId && edge.targetStageId !== stageId)
    draft.selectedStageId = draft.stages[0]?.id
    render()
  }

  async function save(): Promise<void> {
    const chat = deps.getCurrentChat()
    if (!chat || !validateDraft(false)) return
    const flow = buildFlow(chat)
    await deps.runCommand('GROUP_ORCHESTRATION_FLOW_SAVE', { chatId: chat.id, flow })
    draft.flowId = flow.id
    deps.showSuccess('编排流程已保存')
  }

  async function run(): Promise<void> {
    const chat = deps.getCurrentChat()
    const task = deps.orchestrationTaskEl.value.trim()
    if (!chat || !validateDraft(true)) return
    if (!task) {
      deps.showError('请输入编排任务')
      return
    }
    const flow = buildFlow(chat)
    await deps.reconnectRolesForSend(chat, getDraftRoles())
    await deps.runCommand('GROUP_ORCHESTRATION_RUN', { chatId: chat.id, task, flow })
    draft.flowId = flow.id
    deps.showSuccess('编排任务已开始')
    close()
  }

  function buildFlow(chat: GroupChat): OrchestrationFlow {
    const now = Date.now()
    const graphEdges = filterGraphEdges(draft.graphEdges, draft.stages)
    const stages = orderStagesByGraph(cloneStages(draft.stages), graphEdges)
    const task = deps.orchestrationTaskEl.value.trim()
    return {
      id: draft.flowId ?? newId('flow'),
      chatId: chat.id,
      name: `${chat.name} 编排流程`,
      description: task || undefined,
      stages,
      graph: {
        stageNodes: stages,
        edges: graphEdges,
      },
      maxRounds: readMaxRoundsInput(deps.orchestrationMaxRoundsEl),
      createdAt: now,
      updatedAt: now,
    }
  }

  function validateDraft(requireTask: boolean): boolean {
    if (deps.getCurrentRoles().length === 0) {
      deps.showError('当前群聊暂无人员，无法编排任务')
      return false
    }
    if (requireTask && !deps.orchestrationTaskEl.value.trim()) {
      deps.showError('请输入编排任务')
      return false
    }
    if (draft.stages.length === 0) {
      deps.showError('请至少添加一个执行阶段')
      return false
    }
    if (draft.stages.some(stage => stage.roleIds.length === 0)) {
      deps.showError('每个阶段都需要至少一个人员')
      return false
    }
    const review = draft.stages.find(stage => stage.kind === 'review')
    if (review && (!review.review?.reviewerRoleIds.length || !review.review.instructions?.trim())) {
      deps.showError('审核阶段需要审核人员和审核标准')
      return false
    }
    const rawMaxRounds = Number(deps.orchestrationMaxRoundsEl.value)
    if (!Number.isFinite(rawMaxRounds) || rawMaxRounds < 1 || rawMaxRounds > MAX_ORCHESTRATION_MAX_ROUNDS) {
      deps.showError(`最大轮数需在 1-${MAX_ORCHESTRATION_MAX_ROUNDS} 之间`)
      return false
    }
    return true
  }

  function selectedStage(): OrchestrationStage | undefined {
    return draft.stages.find(stage => stage.id === draft.selectedStageId)
  }

  function selectedRolesStage(): OrchestrationStage | undefined {
    const selected = selectedStage()
    return selected?.kind === 'roles' ? selected : undefined
  }

  function getRoleName(roleId: string): string {
    return deps.getStore().rolesById[roleId]?.name ?? '未知人员'
  }

  function getDraftRoles(): GroupRole[] {
    const rolesById = new Map(deps.getCurrentRoles().map(role => [role.id, role]))
    const roleIds = new Set<string>()
    for (const stage of draft.stages) {
      for (const roleId of stage.roleIds) roleIds.add(roleId)
      if (stage.kind === 'review') {
        for (const roleId of stage.review?.reviewerRoleIds ?? []) roleIds.add(roleId)
      }
    }
    return [...roleIds].map(roleId => rolesById.get(roleId)).filter((role): role is GroupRole => Boolean(role))
  }

  function registerOrchestrationEvents(): void {
    deps.openOrchestrationEl.addEventListener('click', open)
    deps.closeOrchestrationEl.addEventListener('click', close)
    deps.orchestrationMaxRoundsEl.addEventListener('input', render)
    deps.saveOrchestrationEl.addEventListener('click', () => save().catch(error => deps.showError(error instanceof Error ? error.message : String(error))))
    deps.runOrchestrationEl.addEventListener('click', () => run().catch(error => deps.showError(error instanceof Error ? error.message : String(error))))
  }

  return { close, render, registerOrchestrationEvents }
}

function cloneStages(stages: OrchestrationStage[]): OrchestrationStage[] {
  return stages.map(stage => ({
    ...stage,
    roleIds: [...stage.roleIds],
    review: stage.review ? { ...stage.review, reviewerRoleIds: [...stage.review.reviewerRoleIds] } : undefined,
  }))
}

function cloneGraphEdges(edges: OrchestrationGraphSnapshot['edges']): OrchestrationGraphSnapshot['edges'] {
  return edges.map(edge => ({ sourceStageId: edge.sourceStageId, targetStageId: edge.targetStageId }))
}

function sequentialGraphEdges(stages: OrchestrationStage[]): OrchestrationGraphSnapshot['edges'] {
  return stages.slice(1).map((stage, index) => ({ sourceStageId: stages[index].id, targetStageId: stage.id }))
}

function filterGraphEdges(edges: OrchestrationGraphSnapshot['edges'], stages: OrchestrationStage[]): OrchestrationGraphSnapshot['edges'] {
  const stageIds = new Set(stages.map(stage => stage.id))
  const seen = new Set<string>()
  const result: OrchestrationGraphSnapshot['edges'] = []
  for (const edge of edges) {
    if (!stageIds.has(edge.sourceStageId) || !stageIds.has(edge.targetStageId) || edge.sourceStageId === edge.targetStageId) continue
    const key = `${edge.sourceStageId}->${edge.targetStageId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ sourceStageId: edge.sourceStageId, targetStageId: edge.targetStageId })
  }
  return result
}

export function orderStagesByGraph(stages: OrchestrationStage[], edges: OrchestrationGraphSnapshot['edges']): OrchestrationStage[] {
  const stageIds = new Set(stages.map(stage => stage.id))
  const validEdges = filterGraphEdges(edges, stages)
  if (validEdges.length === 0) return stages

  const outgoing = new Map<string, string[]>()
  const indegree = new Map(stages.map(stage => [stage.id, 0]))
  for (const edge of validEdges) {
    outgoing.set(edge.sourceStageId, [...outgoing.get(edge.sourceStageId) ?? [], edge.targetStageId])
    indegree.set(edge.targetStageId, (indegree.get(edge.targetStageId) ?? 0) + 1)
  }

  const byId = new Map(stages.map(stage => [stage.id, stage]))
  const queue = stages.filter(stage => (indegree.get(stage.id) ?? 0) === 0)
  const ordered: OrchestrationStage[] = []
  const emitted = new Set<string>()
  for (let index = 0; index < queue.length; index += 1) {
    const stage = queue[index]
    if (!stage || emitted.has(stage.id)) continue
    ordered.push(stage)
    emitted.add(stage.id)
    for (const targetId of outgoing.get(stage.id) ?? []) {
      if (!stageIds.has(targetId)) continue
      const nextIndegree = (indegree.get(targetId) ?? 0) - 1
      indegree.set(targetId, nextIndegree)
      const target = byId.get(targetId)
      if (target && nextIndegree === 0) queue.push(target)
    }
  }

  if (ordered.length === stages.length) return ordered
  return [...ordered, ...stages.filter(stage => !emitted.has(stage.id))]
}

function clampMaxRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ORCHESTRATION_MAX_ROUNDS
  return Math.min(MAX_ORCHESTRATION_MAX_ROUNDS, Math.max(1, Math.trunc(value)))
}

function readMaxRoundsInput(input: HTMLInputElement): number {
  return clampMaxRounds(Number(input.value || DEFAULT_ORCHESTRATION_MAX_ROUNDS))
}

function roleInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '员'
}

function roleToneClass(seed: string): string {
  const tones = ['tone-blue', 'tone-green', 'tone-purple', 'tone-orange']
  const total = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  return tones[total % tones.length]
}

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
