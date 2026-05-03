import type { ChatSiteAdapter, ConversationSnapshot } from './types'
import { keepDeepestResponseContainers } from '../responseContainers'
import { extractMarkdownFromDom } from './domMarkdown'
import { buttonLabelMatches, describeElement, extractCleanTextFromDom, findClosestMatchingAncestor } from './domText'
import { waitForElement } from './waitForElement'

const QWEN_HOST = 'www.qianwen.com'
const QWEN_ORIGIN = `https://${QWEN_HOST}`
const QWEN_HOME_URL = `${QWEN_ORIGIN}/`
const DEFAULT_INPUT_TIMEOUT_MS = 9000
const QWEN_DEBUG_EVENT_LIMIT = 40
const QWEN_PAGE_WORLD_WRITE_TIMEOUT_MS = 800
const QWEN_WRITE_REQUEST_EVENT = 'openteam:qwen-write-request'
const QWEN_WRITE_RESPONSE_EVENT = 'openteam:qwen-write-response'

const QWEN_SELECTORS = {
  editor: '[data-slate-editor="true"][contenteditable="true"][role="textbox"], [data-placeholder="向千问提问"][contenteditable="true"]',
  composer: '[data-chat-input-shell="true"], [data-chat-input-layout="true"], [data-chat-input-body="true"]',
  response: '.answer-common-card .qk-markdown, .qk-markdown.qk-markdown-complete',
  responseContainer: '.answer-common-card, [data-chat-answers-wrap], .message-select-wrapper-answer-rqWekn',
  sendButton: 'button[aria-label="发送消息"], button',
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'TEXTAREA', 'SVG', 'CANVAS'])

interface QwenWriteResult {
  accepted: boolean
  strategy: string
  attempts: Array<Record<string, unknown>>
}

interface QwenAdapterOptions {
  href?: string
  inputTimeoutMs?: number
}

interface QwenDebugEvent {
  at: number
  stage: string
  details: Record<string, unknown>
}

const qwenDebugEvents: QwenDebugEvent[] = []

export function createQwenAdapter(options: QwenAdapterOptions = {}): ChatSiteAdapter {
  const inputTimeoutMs = options.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS

  function currentHref(): string {
    return options.href ?? location.href
  }

  function getConversationSnapshot(): ConversationSnapshot {
    return getQwenConversationLocation(currentHref())
  }

  function getConversationId(): string {
    return getConversationSnapshot().conversationId || '__default__'
  }

  function getResponseContainers(): Element[] {
    return [...document.querySelectorAll(QWEN_SELECTORS.response)].filter(isFinalResponseMarkdown)
  }

  function getAllAssistantReplies(): string[] {
    return keepDeepestResponseContainers(getResponseContainers()).map(container => extractCleanText(container)).filter(Boolean)
  }

  async function fillAndSend(content: string, autoSend = true): Promise<void> {
    logQwenDebug('fill:start', {
      href: currentHref(),
      contentLength: content.length,
      trimmedContentLength: content.trim().length,
      autoSend,
    })
    const editor = await waitForElement(QWEN_SELECTORS.editor, inputTimeoutMs)
    if (!(editor instanceof HTMLElement)) {
      logQwenDebug('fill:editor-invalid', { matchedNode: describeElement(editor) })
      throw new Error('Qwen editor is not an editable element')
    }
    logQwenDebug('fill:editor-found', getEditorSnapshot(editor))

    const writeResult = await setQwenEditorText(editor, content)
    logQwenDebug('fill:write-result', {
      accepted: writeResult.accepted,
      strategy: writeResult.strategy,
      attempts: writeResult.attempts,
      ...getEditorSnapshot(editor),
      sendButtons: describeQwenSendButtons(editor),
    })
    if (!writeResult.accepted) {
      throw new Error('Qwen editor did not accept the prompt text')
    }

    if (!autoSend) return

    const sendButton = await waitForQwenSendButton(editor, inputTimeoutMs)
    const responseCountBeforeSend = document.querySelectorAll(QWEN_SELECTORS.response).length
    logQwenDebug('fill:click-send', {
      sendButton: describeElement(sendButton),
      sendButtons: describeQwenSendButtons(editor),
      responseCountBeforeSend,
    })
    const activation = activateQwenSendButton(sendButton)
    await waitForQwenEditorSettle(350)
    logQwenDebug('fill:after-click', {
      activation,
      responseCountBeforeSend,
      responseCountAfterClick: document.querySelectorAll(QWEN_SELECTORS.response).length,
      ...getEditorSnapshot(editor),
      sendButtons: describeQwenSendButtons(editor),
      isGenerating: isQwenGenerating(),
    })
  }

  return {
    id: 'qwen',
    getConversationSnapshot,
    getConversationId,
    getResponseContainers,
    getAllAssistantReplies,
    readResponseText: extractCleanText,
    readResponseMarkdown: extractMarkdownFromDom,
    findResponseContainer,
    isGenerating: isQwenGenerating,
    stopGenerating: stopQwenGenerating,
    fillAndSend,
    collectPromptDiagnostics,
  }
}

export function getQwenConversationLocation(href: string): ConversationSnapshot {
  const url = parseSafeQwenUrl(href)
  if (!url) return {}

  return {
    conversationId: extractConversationId(url),
    conversationUrl: url.href,
  }
}

function parseSafeQwenUrl(value: string | undefined): URL | undefined {
  if (!value || !value.startsWith(QWEN_HOME_URL)) return undefined

  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === QWEN_HOST ? url : undefined
  } catch {
    return undefined
  }
}

function extractConversationId(url: URL): string | undefined {
  const pathConversationId = url.pathname.match(/^\/chat\/([^/]+)/)?.[1]
  const conversationId = pathConversationId ?? url.searchParams.get('chatId') ?? url.searchParams.get('sessionId')
  return conversationId ? decodeURIComponent(conversationId) : undefined
}

async function setQwenEditorText(editor: HTMLElement, content: string): Promise<QwenWriteResult> {
  const attempts: Array<Record<string, unknown>> = []

  const beforeInputAccepted = insertTextWithBeforeInput(editor, content)
  attempts.push({ strategy: 'beforeinput', accepted: beforeInputAccepted, ...getEditorSnapshot(editor) })
  if (beforeInputAccepted) return { accepted: true, strategy: 'beforeinput', attempts }

  const nativeAccepted = insertTextWithNativeEditing(editor, content)
  attempts.push({ strategy: 'execCommand.insertText', accepted: nativeAccepted, ...getEditorSnapshot(editor) })
  if (nativeAccepted) return { accepted: true, strategy: 'execCommand.insertText', attempts }

  const pageWorldResult = await insertTextWithPageWorldWriter(editor, content)
  attempts.push({ strategy: 'page-world-writer', accepted: pageWorldResult.accepted, response: pageWorldResult.response, ...getEditorSnapshot(editor) })
  if (pageWorldResult.accepted) return { accepted: true, strategy: 'page-world-writer', attempts }

  const clipboardResult = await insertTextWithClipboardPaste(editor, content)
  attempts.push({ strategy: 'clipboard-paste', accepted: clipboardResult.accepted, ...clipboardResult.diagnostics, ...getEditorSnapshot(editor) })
  if (clipboardResult.accepted) return { accepted: true, strategy: 'clipboard-paste', attempts }

  replaceQwenSlateDom(editor, content)
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }))
  editor.dispatchEvent(new Event('change', { bubbles: true }))
  const domAccepted = hasExactlyAcceptedQwenEditorText(editor, content)
  attempts.push({ strategy: 'dom-fallback', accepted: domAccepted, ...getEditorSnapshot(editor) })
  return { accepted: domAccepted, strategy: domAccepted ? 'dom-fallback' : 'none', attempts }
}

function insertTextWithBeforeInput(editor: HTMLElement, content: string): boolean {
  if (typeof document.execCommand !== 'function') return false

  editor.focus()
  if (!selectEditorContents(editor)) return false
  document.execCommand('delete', false)
  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: content }))
  return hasExactlyAcceptedQwenEditorText(editor, content)
}

function insertTextWithNativeEditing(editor: HTMLElement, content: string): boolean {
  if (typeof document.execCommand !== 'function') return false

  editor.focus()
  if (!selectEditorContents(editor)) return false
  document.execCommand('delete', false)
  const inserted = document.execCommand('insertText', false, content)
  return inserted && hasExactlyAcceptedQwenEditorText(editor, content)
}

async function insertTextWithPageWorldWriter(editor: HTMLElement, content: string): Promise<{ accepted: boolean; response?: Record<string, unknown> }> {
  const requestId = `qwen-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const response = await waitForQwenPageWorldWriteResponse(requestId, content)
  const domAccepted = hasExactlyAcceptedQwenEditorText(editor, content)
  const responseAccepted = doesQwenWriteResponseMatchContent(response, content)

  return {
    accepted: domAccepted,
    response: response ? { ...response, responseAccepted, domAccepted } : { responseAccepted, domAccepted, reason: 'response-timeout' },
  }
}

async function insertTextWithClipboardPaste(
  editor: HTMLElement,
  content: string,
): Promise<{ accepted: boolean; diagnostics: Record<string, unknown> }> {
  if (typeof document.execCommand !== 'function') {
    return { accepted: false, diagnostics: { reason: 'execCommand-unavailable' } }
  }

  const clipboard = navigator.clipboard
  if (!clipboard?.writeText) {
    return { accepted: false, diagnostics: { reason: 'clipboard-write-unavailable' } }
  }

  let previousClipboardText: string | undefined
  try {
    previousClipboardText = clipboard.readText ? await clipboard.readText() : undefined
  } catch {
    previousClipboardText = undefined
  }

  try {
    await clipboard.writeText(content)
    editor.focus()
    if (!selectEditorContents(editor)) return { accepted: false, diagnostics: { reason: 'select-failed' } }
    document.execCommand('delete', false)
    const pasted = document.execCommand('paste', false)
    return { accepted: pasted && hasExactlyAcceptedQwenEditorText(editor, content), diagnostics: { pasted } }
  } catch (error) {
    return { accepted: false, diagnostics: { reason: error instanceof Error ? error.message : String(error) } }
  } finally {
    if (previousClipboardText !== undefined) {
      try {
        await clipboard.writeText(previousClipboardText)
      } catch {
        // Best effort restore only.
      }
    }
  }
}

function waitForQwenPageWorldWriteResponse(requestId: string, content: string): Promise<Record<string, unknown> | undefined> {
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      document.documentElement.removeEventListener(QWEN_WRITE_RESPONSE_EVENT, onResponse)
      resolve(undefined)
    }, QWEN_PAGE_WORLD_WRITE_TIMEOUT_MS)

    function onResponse(event: Event): void {
      const detail = parseQwenEventDetail((event as CustomEvent<unknown>).detail)
      if (detail?.requestId !== requestId) return

      window.clearTimeout(timeout)
      document.documentElement.removeEventListener(QWEN_WRITE_RESPONSE_EVENT, onResponse)
      resolve(detail)
    }

    document.documentElement.addEventListener(QWEN_WRITE_RESPONSE_EVENT, onResponse)
    document.documentElement.dispatchEvent(
      new CustomEvent(QWEN_WRITE_REQUEST_EVENT, {
        detail: JSON.stringify({ requestId, content, selector: QWEN_SELECTORS.editor }),
      }),
    )
  })
}

function replaceQwenSlateDom(editor: HTMLElement, content: string): void {
  editor.focus()
  editor.replaceChildren()
  const lines = content.split('\n')
  const paragraphs = lines.length > 0 ? lines : ['']
  for (const line of paragraphs) {
    editor.append(createSlateParagraph(line))
  }
}

function createSlateParagraph(content: string): HTMLParagraphElement {
  const paragraph = document.createElement('p')
  paragraph.setAttribute('data-slate-node', 'element')

  const textNode = document.createElement('span')
  textNode.setAttribute('data-slate-node', 'text')
  const leaf = document.createElement('span')
  leaf.setAttribute('data-slate-leaf', 'true')
  const text = document.createElement('span')
  text.setAttribute('data-slate-string', 'true')
  text.textContent = content || '\uFEFF'

  leaf.append(text)
  textNode.append(leaf)
  paragraph.append(textNode)
  return paragraph
}

async function waitForQwenSendButton(editor: HTMLElement, timeoutMs: number): Promise<HTMLElement> {
  const startedAt = Date.now()
  while (Date.now() - startedAt <= timeoutMs) {
    const button = findQwenSendButton(editor)
    if (button) {
      logQwenDebug('send-button:ready', {
        elapsedMs: Date.now() - startedAt,
        button: describeElement(button),
        sendButtons: describeQwenSendButtons(editor),
      })
      return button
    }
    await new Promise(resolve => window.setTimeout(resolve, 50))
  }

  logQwenDebug('send-button:timeout', {
    elapsedMs: Date.now() - startedAt,
    ...getEditorSnapshot(editor),
    sendButtons: describeQwenSendButtons(editor),
  })
  throw new Error('Qwen 发送按钮暂不可用，请稍后重试')
}

function findQwenSendButton(editor: HTMLElement): HTMLElement | undefined {
  const composer = editor.closest(QWEN_SELECTORS.composer) ?? document.body
  return [...composer.querySelectorAll<HTMLElement>(QWEN_SELECTORS.sendButton)].find(isQwenSendButton)
}

function isQwenSendButton(button: HTMLElement): boolean {
  if (button.getAttribute('aria-disabled') === 'true') return false
  if (button instanceof HTMLButtonElement && button.disabled) return false
  if (button.getAttribute('aria-label') !== '发送消息' && !button.querySelector('[data-icon-type="qwpcicon-sendChat"]')) return false
  return isVisibleInteractiveElement(button)
}

function activateQwenSendButton(button: HTMLElement): Record<string, unknown> {
  const target = button.querySelector<HTMLElement>('[data-icon-type="qwpcicon-sendChat"], svg, path') ?? button
  button.focus()
  const eventResults = [
    dispatchQwenMouseEvent(target, 'pointerdown'),
    dispatchQwenMouseEvent(target, 'mousedown'),
    dispatchQwenMouseEvent(target, 'pointerup'),
    dispatchQwenMouseEvent(target, 'mouseup'),
    dispatchQwenMouseEvent(target, 'click'),
  ]
  return {
    activeElement: document.activeElement ? describeElement(document.activeElement) : undefined,
    target: describeElement(target),
    eventResults,
  }
}

function dispatchQwenMouseEvent(target: HTMLElement, type: string): Record<string, unknown> {
  const EventConstructor = type.startsWith('pointer') && typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent
  const event = new EventConstructor(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    buttons: type.endsWith('down') ? 1 : 0,
  } as MouseEventInit)
  const dispatched = target.dispatchEvent(event)
  return {
    type,
    dispatched,
    defaultPrevented: event.defaultPrevented,
    isTrusted: event.isTrusted,
  }
}

function collectPromptDiagnostics(): Record<string, unknown> {
  const editor = document.querySelector<HTMLElement>(QWEN_SELECTORS.editor)
  return {
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    title: document.title,
    editorMatches: [...document.querySelectorAll(QWEN_SELECTORS.editor)].slice(0, 5).map(describeElement),
    sendButtonMatches: [...document.querySelectorAll(QWEN_SELECTORS.sendButton)].slice(0, 5).map(describeElement),
    visibleButtonSamples: [...document.querySelectorAll('button, [role="button"]')].slice(0, 12).map(describeElement),
    sendButtons: editor ? describeQwenSendButtons(editor) : [],
    editorTextLength: editor ? readQwenEditorText(editor).length : undefined,
    editorTextPreview: editor ? readQwenEditorText(editor).slice(0, 120) : undefined,
    editorHtmlPreview: editor ? editor.innerHTML.slice(0, 240) : undefined,
    qwenDebugEvents: qwenDebugEvents.slice(-15),
  }
}

function extractCleanText(node: Node): string {
  return extractCleanTextFromDom(node, { skipTags: SKIP_TAGS })
}

function findResponseContainer(element: Element | null): Element | null {
  const finalMarkdown = findClosestMatchingAncestor(element, QWEN_SELECTORS.response)
  return finalMarkdown && isFinalResponseMarkdown(finalMarkdown) ? finalMarkdown : null
}

function isFinalResponseMarkdown(element: Element): boolean {
  if (element.closest('.question-text-card, .message-card-wrap.question')) return false
  return Boolean(element.closest(QWEN_SELECTORS.responseContainer))
}

function isQwenGenerating(): boolean {
  return Boolean(findQwenStopButton())
}

async function stopQwenGenerating(): Promise<boolean> {
  const button = findQwenStopButton()
  if (!button) return false
  button.click()
  return true
}

function findQwenStopButton(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(button => isQwenStopButton(button) && isVisibleInteractiveElement(button))
}

function isQwenStopButton(button: HTMLElement): boolean {
  if (button instanceof HTMLButtonElement && button.disabled) return false
  if (button.getAttribute('aria-disabled') === 'true') return false
  if (button.querySelector('[data-icon-type*="stop"], [data-icon-type*="pause"]')) return true
  return buttonLabelMatches(button, /stop|stopping|停止|中止|暂停/)
}

function getEditorSnapshot(editor: HTMLElement): Record<string, unknown> {
  const text = readQwenEditorText(editor)
  return {
    editorTextLength: text.length,
    editorTextPreview: text.slice(0, 120),
    editorHtmlPreview: editor.innerHTML.slice(0, 240),
    activeElement: document.activeElement ? describeElement(document.activeElement) : undefined,
  }
}

function hasExactlyAcceptedQwenEditorText(editor: HTMLElement, content: string): boolean {
  return normalizeEditorText(readQwenEditorText(editor)) === normalizeEditorText(content)
}

function normalizeEditorText(value: string): string {
  return value
    .replace(/\uFEFF/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim()
}

function parseQwenEventDetail(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
    } catch {
      return undefined
    }
  }
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function doesQwenWriteResponseMatchContent(response: Record<string, unknown> | undefined, content: string): boolean {
  if (!response?.ok) return false

  const responseText = typeof response.text === 'string' ? response.text : ''
  return normalizeEditorText(responseText) === normalizeEditorText(content)
}

function readQwenEditorText(editor: HTMLElement): string {
  const paragraphs = [...editor.querySelectorAll('p')]
  if (paragraphs.length > 0) return paragraphs.map(readQwenParagraphText).join('\n').trim()

  const slateStrings = [...editor.querySelectorAll<HTMLElement>('[data-slate-string="true"]')]
  if (slateStrings.length > 0) return slateStrings.map(node => node.textContent || '').join('').trim()

  if (editor.innerText) return editor.innerText.trim()

  return (editor.textContent || '').trim()
}

function readQwenParagraphText(paragraph: Element): string {
  const slateStrings = [...paragraph.querySelectorAll<HTMLElement>('[data-slate-string="true"]')]
  if (slateStrings.length > 0) return slateStrings.map(node => node.textContent || '').join('').replace(/\uFEFF/g, '')

  const buffer: string[] = []
  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer.push(node.textContent || '')
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return

    const element = node as Element
    if (element.getAttribute('data-slate-placeholder') === 'true') return
    if (element.getAttribute('data-slate-zero-width')) return
    if (element.getAttribute('contenteditable') === 'false') return

    for (const child of element.childNodes) visit(child)
  }

  visit(paragraph)
  return buffer.join('').replace(/\uFEFF/g, '')
}

function selectEditorContents(editor: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection) return false

  const range = document.createRange()
  range.selectNodeContents(editor)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

function isVisibleInteractiveElement(element: Element): boolean {
  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') return false
  return true
}

function describeQwenSendButtons(editor: HTMLElement): Array<Record<string, unknown>> {
  const composer = editor.closest(QWEN_SELECTORS.composer) ?? document.body
  return [...composer.querySelectorAll<HTMLElement>('button')]
    .slice(0, 12)
    .map(button => ({
      description: describeElement(button),
      className: button.className,
      disabled: button instanceof HTMLButtonElement ? button.disabled : undefined,
      ariaDisabled: button.getAttribute('aria-disabled'),
      label: button.getAttribute('aria-label'),
      text: (button.textContent || '').trim().slice(0, 80),
      iconTypes: [...button.querySelectorAll('[data-icon-type]')].map(icon => icon.getAttribute('data-icon-type')),
      sendCandidate: button.getAttribute('aria-label') === '发送消息' || Boolean(button.querySelector('[data-icon-type="qwpcicon-sendChat"]')),
      clickable: isQwenSendButton(button),
    }))
}

function waitForQwenEditorSettle(timeoutMs = 80): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, timeoutMs))
}

function logQwenDebug(stage: string, details: Record<string, unknown>): void {
  const event = { at: Date.now(), stage, details }
  qwenDebugEvents.push(event)
  if (qwenDebugEvents.length > QWEN_DEBUG_EVENT_LIMIT) qwenDebugEvents.splice(0, qwenDebugEvents.length - QWEN_DEBUG_EVENT_LIMIT)

  try {
    console.info('[OpenTeam][qwen]', stage, details)
  } catch {
    // Logging must never break prompt delivery.
  }
}
