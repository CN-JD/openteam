const QWEN_WRITE_REQUEST_EVENT = 'openteam:qwen-write-request'
const QWEN_WRITE_RESPONSE_EVENT = 'openteam:qwen-write-response'
const bridgeWindow = window as Window & { __OPENTEAM_QWEN_PAGE_WORLD_WRITER__?: boolean }

if (!bridgeWindow.__OPENTEAM_QWEN_PAGE_WORLD_WRITER__) {
  bridgeWindow.__OPENTEAM_QWEN_PAGE_WORLD_WRITER__ = true
  logQwenPageBridge('bridge:installed', {
    href: location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
  })

  document.documentElement.addEventListener(QWEN_WRITE_REQUEST_EVENT, handleQwenWriteRequest)
}

function handleQwenWriteRequest(event: Event): void {
  const detail = parseEventDetail((event as CustomEvent<unknown>).detail)
  if (!detail) return

  const requestId = typeof detail.requestId === 'string' ? detail.requestId : undefined
  const selector = typeof detail.selector === 'string' ? detail.selector : undefined
  const content = typeof detail.content === 'string' ? detail.content : ''

  if (!requestId || !selector) {
    logQwenPageBridge('write:invalid-request', {
      hasRequestId: Boolean(requestId),
      hasSelector: Boolean(selector),
      contentLength: content.length,
    })
    return
  }

  logQwenPageBridge('write:request', {
    requestId,
    selector,
    contentLength: content.length,
    trimmedContentLength: content.trim().length,
    activeElement: describePageElement(document.activeElement),
  })

  const editor = document.querySelector<HTMLElement>(selector)
  if (!editor) {
    respond({ requestId, ok: false, reason: 'editor-not-found', selector })
    logQwenPageBridge('write:editor-not-found', { requestId, selector })
    return
  }

  try {
    editor.focus()
    clearEditor(editor)

    const beforeInputResult = dispatchBeforeInput(editor, content)
    let snapshot = getEditorSnapshot(editor)
    logQwenPageBridge('write:after-beforeinput', { requestId, beforeInputResult, ...snapshot, sendButtons: describeSendButtons(editor) })

    if (!textMatchesContent(snapshot.text, content)) {
      clearEditor(editor)
      const pasteResult = dispatchSyntheticPaste(editor, content)
      snapshot = getEditorSnapshot(editor)
      logQwenPageBridge('write:after-synthetic-paste', { requestId, pasteResult, ...snapshot, sendButtons: describeSendButtons(editor) })
    }

    if (!textMatchesContent(snapshot.text, content) && typeof document.execCommand === 'function') {
      selectContents(editor)
      const deleteResult = document.execCommand('delete', false)
      const insertTextResult = document.execCommand('insertText', false, content)
      snapshot = getEditorSnapshot(editor)
      logQwenPageBridge('write:after-execCommand-insertText', { requestId, deleteResult, insertTextResult, ...snapshot, sendButtons: describeSendButtons(editor) })
    }

    if (!textMatchesContent(snapshot.text, content) && typeof document.execCommand === 'function') {
      selectContents(editor)
      const deleteResult = document.execCommand('delete', false)
      const insertHtmlResult = document.execCommand('insertHTML', false, toSlateParagraphHtml(content))
      snapshot = getEditorSnapshot(editor)
      logQwenPageBridge('write:after-execCommand-insertHTML', { requestId, deleteResult, insertHtmlResult, ...snapshot, sendButtons: describeSendButtons(editor) })
    }

    snapshot = getEditorSnapshot(editor)
    const ok = textMatchesContent(snapshot.text, content)
    respond({
      requestId,
      ok,
      text: snapshot.text.slice(0, 500),
      textLength: snapshot.text.length,
      html: snapshot.html.slice(0, 800),
      activeElement: describePageElement(document.activeElement),
      sendButtons: describeSendButtons(editor),
    })
    logQwenPageBridge('write:respond', {
      requestId,
      ok,
      textLength: snapshot.text.length,
      htmlPreview: snapshot.html.slice(0, 200),
      sendButtons: describeSendButtons(editor),
      activeElement: describePageElement(document.activeElement),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    respond({ requestId, ok: false, reason })
    logQwenPageBridge('write:error', { requestId, reason })
  }
}

function respond(payload: Record<string, unknown>): void {
  document.documentElement.dispatchEvent(new CustomEvent(QWEN_WRITE_RESPONSE_EVENT, { detail: JSON.stringify(payload) }))
}

function clearEditor(editor: HTMLElement): void {
  editor.focus()
  if (!selectContents(editor)) return

  if (typeof document.execCommand === 'function') {
    document.execCommand('delete', false)
  } else {
    editor.replaceChildren()
  }
}

function dispatchBeforeInput(editor: HTMLElement, content: string): boolean {
  try {
    return editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: content }))
  } catch {
    return false
  }
}

function dispatchSyntheticPaste(editor: HTMLElement, content: string): boolean {
  try {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', content)
    clipboardData.setData('text/html', toSlateParagraphHtml(content))
    return editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  } catch {
    return false
  }
}

function parseEventDetail(value: unknown): Record<string, unknown> | undefined {
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

function selectContents(editor: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection) return false

  const range = document.createRange()
  range.selectNodeContents(editor)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

function getEditorSnapshot(editor: HTMLElement): { text: string; html: string } {
  return {
    text: readQwenEditorText(editor),
    html: editor.innerHTML,
  }
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

function textMatchesContent(text: string, content: string): boolean {
  return normalizeText(text) === normalizeText(content)
}

function normalizeText(value: string): string {
  return value
    .replace(/\uFEFF/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .trim()
}

function toSlateParagraphHtml(content: string): string {
  return content
    .split('\n')
    .map(line => {
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
      return `<p data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-string="true">${escaped || '\uFEFF'}</span></span></span></p>`
    })
    .join('')
}

function describeSendButtons(editor: HTMLElement): Array<Record<string, unknown>> {
  const composer = editor.closest('[data-chat-input-shell="true"], [data-chat-input-layout="true"], [data-chat-input-body="true"]') ?? document.body
  return [...composer.querySelectorAll<HTMLButtonElement>('button')]
    .slice(0, 12)
    .map(button => ({
      tagName: button.tagName,
      className: button.className,
      disabled: button.disabled,
      ariaDisabled: button.getAttribute('aria-disabled'),
      ariaLabel: button.getAttribute('aria-label'),
      iconTypes: [...button.querySelectorAll('[data-icon-type]')].map(icon => icon.getAttribute('data-icon-type')),
    }))
}

function describePageElement(element: Element | null): Record<string, unknown> | undefined {
  if (!element) return undefined
  return {
    tagName: element.tagName,
    id: element.id || undefined,
    className: typeof element.className === 'string' ? element.className : undefined,
    role: element.getAttribute('role') || undefined,
    ariaDisabled: element.getAttribute('aria-disabled') || undefined,
  }
}

function logQwenPageBridge(stage: string, details: Record<string, unknown>): void {
  try {
    console.info('[OpenTeam][qwen-page]', stage, details)
  } catch {
    // Logging is diagnostic only and must never affect page input.
  }
}

export {}
