import type { ChatSiteAdapter, ConversationSnapshot } from './types'
import { keepDeepestResponseContainers } from '../responseContainers'
import { extractMarkdownFromDom } from './domMarkdown'
import { buttonLabelMatches, describeElement, extractCleanTextFromDom, findClosestMatchingAncestor } from './domText'
import { waitForElement } from './waitForElement'

const QWEN_HOST = 'www.qianwen.com'
const QWEN_ORIGIN = `https://${QWEN_HOST}`
const QWEN_HOME_URL = `${QWEN_ORIGIN}/`
const DEFAULT_INPUT_TIMEOUT_MS = 9000

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
    const editor = await waitForElement(QWEN_SELECTORS.editor, inputTimeoutMs)
    if (!(editor instanceof HTMLElement)) {
      throw new Error('Qwen editor is not an editable element')
    }

    const writeResult = await setQwenEditorText(editor, content)
    if (!writeResult.accepted) {
      throw new Error('Qwen editor did not accept the prompt text')
    }

    if (!autoSend) return

    const sendButton = await waitForQwenSendButton(editor, inputTimeoutMs)
    sendButton.click()
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
    if (button) return button
    await new Promise(resolve => window.setTimeout(resolve, 50))
  }

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
    editorTextLength: editor ? readQwenEditorText(editor).length : undefined,
    editorTextPreview: editor ? readQwenEditorText(editor).slice(0, 120) : undefined,
    editorHtmlPreview: editor ? editor.innerHTML.slice(0, 240) : undefined,
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
  return value.replace(/\uFEFF/g, '').trim()
}

function readQwenEditorText(editor: HTMLElement): string {
  if (editor.innerText) return editor.innerText.trim()

  const paragraphs = [...editor.querySelectorAll('p')]
  if (paragraphs.length > 0) return paragraphs.map(paragraph => paragraph.textContent || '').join('\n').trim()

  return (editor.textContent || '').trim()
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
