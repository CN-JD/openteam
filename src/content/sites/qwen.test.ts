// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createQwenAdapter } from './qwen'

describe('Qwen site adapter', () => {
  it('extracts Qwen conversation ids and normalized safe urls', () => {
    const adapter = createQwenAdapter({ href: 'https://www.qianwen.com/chat/abc-123?source=openteam' })

    expect(adapter.getConversationSnapshot()).toEqual({
      conversationId: 'abc-123',
      conversationUrl: 'https://www.qianwen.com/chat/abc-123?source=openteam',
    })
  })

  it('does not report non-Qwen urls', () => {
    const adapter = createQwenAdapter({ href: 'https://www.qianwen.com.evil.example/chat/abc-123' })

    expect(adapter.getConversationSnapshot()).toEqual({
      conversationId: undefined,
      conversationUrl: undefined,
    })
  })

  it('writes prompt text into the Qwen Slate composer', async () => {
    document.body.innerHTML = `
      <div data-chat-input-shell="true">
        <div role="textbox" data-slate-editor="true" contenteditable="true" data-placeholder="向千问提问">
          <p data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-zero-width="n">\uFEFF<br></span></span></span></p>
        </div>
      </div>
    `
    const editor = document.querySelector<HTMLElement>('[data-slate-editor="true"]')!
    const inputListener = vi.fn()
    editor.addEventListener('input', inputListener)

    await createQwenAdapter().fillAndSend('你好 <qwen>', false)

    expect(editor.textContent?.replace(/\uFEFF/g, '')).toBe('你好 <qwen>')
    expect(editor.querySelector('qwen')).toBeNull()
    expect(inputListener).toHaveBeenCalledTimes(1)
  })

  it('accepts multiline prompt text without counting Slate placeholders or zero-width nodes', async () => {
    document.body.innerHTML = `
      <div data-chat-input-shell="true">
        <div role="textbox" data-slate-editor="true" contenteditable="true" data-placeholder="向千问提问">
          <p data-slate-node="element">
            <span data-slate-node="text">
              <span data-slate-leaf="true">
                <span data-slate-zero-width="n" data-slate-length="0">\uFEFF<br></span>
                <span data-slate-placeholder="true" contenteditable="false">向千问提问</span>
              </span>
            </span>
          </p>
        </div>
      </div>
    `
    const content = '你是「产品经理」。\n\n你的职责：\n你是一名产品经理\n\n用户消息：\n1111111\n\n请以「产品经理」身份回复。'

    const adapter = createQwenAdapter()
    await adapter.fillAndSend(content, false)

    const diagnostics = adapter.collectPromptDiagnostics()
    expect(diagnostics.editorTextPreview).toBe(content.slice(0, 120))
  })

  it('uses Qwen beforeinput insertion without duplicating prompt text', async () => {
    document.body.innerHTML = `
      <div data-chat-input-shell="true">
        <div role="textbox" data-slate-editor="true" contenteditable="true" data-placeholder="向千问提问">
          <p data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-string="true">旧内容</span></span></span></p>
        </div>
      </div>
    `
    const editor = document.querySelector<HTMLElement>('[data-slate-editor="true"]')!
    const originalExecCommand = document.execCommand
    const execCommand = vi.fn((command: string) => {
      if (command === 'delete') editor.replaceChildren()
      return true
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })
    editor.addEventListener('beforeinput', event => {
      const data = (event as InputEvent).data
      if (!data) return

      const block = document.createElement('p')
      block.textContent = data
      editor.append(block)
    })

    try {
      await createQwenAdapter().fillAndSend('来自 beforeinput', false)
    } finally {
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: originalExecCommand,
      })
    }

    expect(editor.textContent).toBe('来自 beforeinput')
    expect(execCommand).toHaveBeenCalledWith('delete', false)
    expect(execCommand).not.toHaveBeenCalledWith('insertText', false, '来自 beforeinput')
  })

  it('uses the Qwen page-world writer when isolated-world editing cannot update Slate state', async () => {
    document.body.innerHTML = `
      <div data-chat-input-shell="true">
        <div role="textbox" data-slate-editor="true" contenteditable="true" data-placeholder="向千问提问">
          <p data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-zero-width="n">\uFEFF<br></span></span></span></p>
        </div>
      </div>
    `
    const editor = document.querySelector<HTMLElement>('[data-slate-editor="true"]')!
    const originalExecCommand = document.execCommand
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => true),
    })
    const onWriteRequest = (event: Event) => {
      const rawDetail = (event as CustomEvent<string | { requestId: string; content: string }>).detail
      const detail = typeof rawDetail === 'string' ? JSON.parse(rawDetail) as { requestId: string; content: string } : rawDetail
      editor.replaceChildren()
      for (const line of detail.content.split('\n')) {
        const block = document.createElement('p')
        block.setAttribute('data-slate-node', 'element')
        const text = document.createElement('span')
        text.setAttribute('data-slate-string', 'true')
        text.textContent = line || '\uFEFF'
        block.append(text)
        editor.append(block)
      }
      document.documentElement.dispatchEvent(
        new CustomEvent('openteam:qwen-write-response', {
          detail: JSON.stringify({
            requestId: detail.requestId,
            ok: true,
            text: detail.content,
            textLength: detail.content.length,
            html: editor.innerHTML,
          }),
        }),
      )
    }
    document.documentElement.addEventListener('openteam:qwen-write-request', onWriteRequest)

    const adapter = createQwenAdapter()
    try {
      await adapter.fillAndSend('页面主世界写入', false)
    } finally {
      document.documentElement.removeEventListener('openteam:qwen-write-request', onWriteRequest)
      Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: originalExecCommand,
      })
    }

    const diagnostics = adapter.collectPromptDiagnostics?.() ?? {}
    const events = diagnostics.qwenDebugEvents as Array<{ stage: string; details: { strategy?: string; attempts?: Array<{ strategy?: string; accepted?: boolean }> } }>
    const writeResult = [...events].reverse().find(event => event.stage === 'fill:write-result')?.details
    expect(writeResult?.strategy).toBe('page-world-writer')
    expect(writeResult?.attempts?.find(attempt => attempt.strategy === 'page-world-writer')?.accepted).toBe(true)
  })

  it('clicks the enabled Qwen send button near the composer', async () => {
    document.body.innerHTML = `
      <div data-chat-input-shell="true">
        <div role="textbox" data-slate-editor="true" contenteditable="true" data-placeholder="向千问提问">
          <p data-slate-node="element"><span data-slate-node="text"><span data-slate-leaf="true"><span data-slate-zero-width="n">\uFEFF<br></span></span></span></p>
        </div>
        <button type="button" aria-label="发送消息">
          <span data-role="icon" data-icon-type="qwpcicon-sendChat"></span>
        </button>
      </div>
    `
    const sendButton = document.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!
    const clickListener = vi.fn()
    sendButton.addEventListener('click', clickListener)

    await createQwenAdapter({ inputTimeoutMs: 250 }).fillAndSend('hello', true)

    expect(clickListener).toHaveBeenCalledTimes(1)
  })

  it('reads only final assistant markdown replies and skips user messages', () => {
    document.body.innerHTML = `
      <div data-chat-list-key>
        <div class="message-card-wrap question">
          <div class="question-text-card">用户问题</div>
        </div>
        <div class="answer-common-card">
          <div class="qk-markdown qk-markdown-react qk-markdown-code-dark qk-markdown-complete">
            <p>嗨，来啦，今天怎么样？</p>
          </div>
        </div>
      </div>
    `

    expect(createQwenAdapter().getAllAssistantReplies()).toEqual(['嗨，来啦，今天怎么样？'])
  })

  it('converts Qwen reply DOM to markdown', () => {
    document.body.innerHTML = `
      <div class="answer-common-card">
        <div class="qk-markdown qk-markdown-complete">
          <h2>方案</h2>
          <p><strong>结论</strong>：可以做</p>
          <ul><li>先接入 adapter</li><li>再验证 iframe</li></ul>
        </div>
      </div>
    `
    const response = document.querySelector('.qk-markdown')!

    expect(createQwenAdapter().readResponseMarkdown?.(response)).toBe('## 方案\n\n**结论**：可以做\n\n- 先接入 adapter\n- 再验证 iframe')
  })
})
