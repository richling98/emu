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
  onRemoveImage?: (id: string) => void
}

function plainTextFromEditable(element: HTMLElement): string {
  return element.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '')
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
  onRemoveImage
}: Props) {
  const editorRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)

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

  return (
    <div ref={rootRef} className={`rich-input-composer${active ? ' rich-input-composer--active' : ''}${dropActive ? ' rich-input-composer--drop-active' : ''}`}>
      <div className="rich-input-composer__prompt">$</div>
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

          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            const text = plainTextFromEditable(event.currentTarget)
            if (!text.trim() && images.length === 0) return
            event.currentTarget.innerText = ''
            onChange('')
            onCommit(text)
            return
          }

          if (event.key === 'Escape') {
            event.preventDefault()
            onTerminalHotkey?.('\x1b')
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
              <img src={image.previewUrl} alt="" className="rich-input-composer__image-thumb" />
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
