import { useEffect, useRef, type Ref } from 'react'

export interface ComposerImageAttachment {
  id: string
  name: string
  path: string
  previewUrl: string
}

interface Props {
  value: string
  active: boolean
  focused?: boolean
  dropActive?: boolean
  rootRef?: Ref<HTMLDivElement>
  images?: ComposerImageAttachment[]
  placeholder?: string
  onChange: (value: string) => void
  onCommit: (value: string) => void
  onActivate?: () => void
  onInterrupt?: () => void
  onTerminalHotkey?: (data: string) => void
  onPasteImages?: (files: File[]) => void
  onAttachFiles?: (files: File[]) => void
  onRemoveImage?: (id: string) => void
}

function plainTextFromEditable(element: HTMLElement): string {
  return element.innerText
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\n+$/, '')
}

function insertTextAtSelection(text: string): void {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  selection.deleteFromDocument()
  selection.getRangeAt(0).insertNode(document.createTextNode(text))
  selection.collapseToEnd()
}

export default function RichInputComposer({
  value,
  active,
  focused = active,
  dropActive = false,
  rootRef,
  images = [],
  placeholder = 'Type a command…',
  onChange,
  onCommit,
  onActivate,
  onInterrupt,
  onTerminalHotkey,
  onPasteImages,
  onAttachFiles,
  onRemoveImage
}: Props) {
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const commitLockRef = useRef(false)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (document.activeElement === editor) return
    if (plainTextFromEditable(editor) === value) return
    editor.innerText = value
  }, [value])

  useEffect(() => {
    if (!active || !focused) return
    window.setTimeout(() => editorRef.current?.focus(), 0)
  }, [active, focused])

  const syncValue = () => {
    const editor = editorRef.current
    if (!editor) return
    onChange(plainTextFromEditable(editor))
  }

  const scrubLeakedLineBreak = (editor: HTMLDivElement) => {
    window.setTimeout(() => {
      if (plainTextFromEditable(editor).trim() !== '') return
      editor.innerText = ''
      onChange('')
    }, 0)
  }

  const commitCurrentValue = (editor = editorRef.current) => {
    if (!editor) return
    if (commitLockRef.current) return
    commitLockRef.current = true
    window.setTimeout(() => { commitLockRef.current = false }, 80)

    const text = plainTextFromEditable(editor)
    if (!text.trim() && images.length === 0) {
      editor.innerText = ''
      onChange('')
      scrubLeakedLineBreak(editor)
      return
    }
    editor.innerText = ''
    onChange('')
    onCommit(text)
    scrubLeakedLineBreak(editor)
  }

  return (
    <div ref={rootRef} className={`rich-input-composer${active ? ' rich-input-composer--active' : ''}${dropActive ? ' rich-input-composer--drop-active' : ''}`}>
      <button
        type="button"
        className="rich-input-composer__attach-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => fileInputRef.current?.click()}
        title="Attach a file"
        aria-label="Attach a file"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        className="rich-input-composer__file-input"
        style={{ display: 'none' }}
        multiple
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : []
          if (files.length > 0) onAttachFiles?.(files)
          // Reset so selecting same file again still fires
          e.target.value = ''
        }}
      />
      <div
        ref={editorRef}
        className="rich-input-composer__editor"
        contentEditable={active}
        suppressContentEditableWarning
        spellCheck={false}
        data-placeholder={placeholder}
        onFocus={onActivate}
        onMouseDown={onActivate}
        onInput={syncValue}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false; syncValue() }}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Enter') return

          event.preventDefault()
          event.stopPropagation()

          if (event.shiftKey) {
            if (!composingRef.current && !event.nativeEvent.isComposing) {
              insertTextAtSelection('\n')
              syncValue()
            }
            return
          }

          if (!composingRef.current && !event.nativeEvent.isComposing) {
            commitCurrentValue(event.currentTarget)
          }
        }}
        onBeforeInput={(event) => {
          const inputEvent = event.nativeEvent as InputEvent
          if (inputEvent.inputType !== 'insertParagraph' && inputEvent.inputType !== 'insertLineBreak') return

          event.preventDefault()
          event.stopPropagation()
          if (!composingRef.current && !inputEvent.isComposing) commitCurrentValue(event.currentTarget)
        }}
        onPaste={(event) => {
          event.preventDefault()
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
          if (files.length > 0) onPasteImages?.(files)
          const text = event.clipboardData.getData('text/plain')
          if (text) insertTextAtSelection(text)
          syncValue()
        }}
        onKeyDown={(event) => {
          if (composingRef.current) return

          if (event.key === 'Escape') {
            event.preventDefault()
            onTerminalHotkey?.('\x1b')
            return
          }

          if (event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'k') {
            event.preventDefault()
            // Cmd+K — forward clear-screen to shell
            onTerminalHotkey?.('\x0c')
            return
          }

          if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'u') {
            event.preventDefault()
            event.currentTarget.innerText = ''
            onChange('')
            return
          }

          if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'c') {
            const selection = window.getSelection()?.toString() ?? ''
            if (!selection) {
              event.preventDefault()
              event.currentTarget.innerText = ''
              onChange('')
              onInterrupt?.()
            }
            return
          }

          if (event.key === 'Tab') {
            event.preventDefault()
            insertTextAtSelection('  ')
            syncValue()
          }
        }}
      />
      {images.length > 0 && (
        <div className="rich-input-composer__images" aria-label="Attached images">
          {images.map((image) => (
            <div key={image.id} className="rich-input-composer__image-chip">
              {image.previewUrl ? (
                <img src={image.previewUrl} alt="" className="rich-input-composer__image-thumb" />
              ) : (
                <div className="rich-input-composer__file-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                </div>
              )}
              <div className="rich-input-composer__image-meta">
                <div className="rich-input-composer__image-name">{image.name}</div>
                <div className="rich-input-composer__image-path">{image.path}</div>
              </div>
              <button
                type="button"
                className="rich-input-composer__image-remove"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onRemoveImage?.(image.id)}
                aria-label={`Remove ${image.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
