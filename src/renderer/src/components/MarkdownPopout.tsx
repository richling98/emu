import { useEffect, useMemo, useRef, useState } from 'react'
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import './MarkdownPopout.css'

type MarkdownViewMode = 'preview' | 'source'

interface Props {
  document: MarkdownOpenResult
  collapsed: boolean
  viewMode: MarkdownViewMode
  onViewModeChange: (mode: MarkdownViewMode) => void
  onCollapse: () => void
  onExpand: () => void
  onClose: () => void
  onOpenResult: (result: MarkdownOpenResult) => void
  onRestoreFocus: () => void
  onResizeStart: (clientX: number) => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
}

function displayName(document: MarkdownOpenResult): string {
  if (document.ok) return document.name
  return document.path?.split('/').pop() || 'Markdown'
}

function displayPath(document: MarkdownOpenResult): string {
  if (document.ok) return document.path
  return document.path || document.error
}

function findMarkdownImageSources(markdown: string): string[] {
  const sources = new Set<string>()
  const imagePattern = /!\[[^\]]*]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g
  for (const match of markdown.matchAll(imagePattern)) {
    const src = match[1]?.trim()
    if (src && !/^https?:\/\//i.test(src) && !src.startsWith('data:')) sources.add(src)
  }
  return [...sources]
}

export default function MarkdownPopout({
  document,
  collapsed,
  viewMode,
  onViewModeChange,
  onCollapse,
  onExpand,
  onClose,
  onOpenResult,
  onRestoreFocus,
  onResizeStart
}: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLPreElement>(null)
  const previewScrollRef = useRef(0)
  const sourceScrollRef = useRef(0)
  const [imageDataBySrc, setImageDataBySrc] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!collapsed) panelRef.current?.focus()
  }, [collapsed, document])

  useEffect(() => {
    setImageDataBySrc({})
    previewScrollRef.current = 0
    sourceScrollRef.current = 0
  }, [document.ok ? document.path : document.path ?? document.error])

  useEffect(() => {
    if (!document.ok) return
    const sources = findMarkdownImageSources(document.markdown)
    if (sources.length === 0) return
    let cancelled = false

    sources.forEach((src) => {
      window.api.markdownImage({ rawPath: src, cwd: document.directory }).then((result) => {
        if (cancelled || !result.ok) return
        setImageDataBySrc((current) => ({ ...current, [src]: result.dataUrl }))
      })
    })

    return () => { cancelled = true }
  }, [document])

  useEffect(() => {
    const target = viewMode === 'preview' ? previewRef.current : sourceRef.current
    if (!target) return
    target.scrollTop = viewMode === 'preview' ? previewScrollRef.current : sourceScrollRef.current
  }, [viewMode])

  const renderedHtml = useMemo(() => {
    if (!document.ok) return ''
    const md = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true
    })

    md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
      const nextToken = tokens[idx + 1]
      const headingText = nextToken?.type === 'inline' ? nextToken.content : ''
      const slug = slugify(headingText)
      if (slug) tokens[idx].attrSet('id', slug)
      return self.renderToken(tokens, idx, options)
    }

    md.renderer.rules.image = (tokens: Token[], idx: number) => {
      const token = tokens[idx]
      const src = token.attrGet('src') ?? ''
      const alt = token.content || token.attrGet('alt') || ''
      const resolvedSrc = imageDataBySrc[src]
      if (!resolvedSrc && !/^https?:\/\//i.test(src) && !src.startsWith('data:')) {
        return `<span class="markdown-image-placeholder">${escapeHtml(alt || src)}</span>`
      }
      return `<img src="${escapeHtml(resolvedSrc || src)}" alt="${escapeHtml(alt)}" loading="lazy" />`
    }

    return md.render(document.markdown)
  }, [document, imageDataBySrc])

  const handleClose = () => {
    onClose()
    onRestoreFocus()
  }

  const handleCollapse = () => {
    onCollapse()
    onRestoreFocus()
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (collapsed) {
      handleClose()
    } else {
      handleCollapse()
    }
  }

  const handlePreviewClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href) return
    event.preventDefault()

    if (href.startsWith('#')) {
      try {
        previewRef.current?.querySelector(href)?.scrollIntoView({ block: 'start' })
      } catch {
        // Invalid fragment selectors are harmless; keep the viewer in place.
      }
      return
    }

    if (/^https?:\/\//i.test(href)) {
      await window.api.openExternal(href)
      return
    }

    if (!document.ok) return
    const result = await window.api.markdownOpen({ rawPath: href, cwd: document.directory })
    if (result.ok) {
      onOpenResult(result)
    } else if (result.reason === 'not-markdown' && result.path) {
      await window.api.openPath(result.path)
    } else {
      onOpenResult(result)
    }
  }

  if (collapsed) {
    return (
      <aside className="markdown-popout markdown-popout--collapsed" onKeyDown={handleKeyDown}>
        <button className="markdown-popout-rail-btn" onClick={onExpand} title={`Open ${displayName(document)}`}>
          MD
        </button>
      </aside>
    )
  }

  return (
    <aside
      ref={panelRef}
      className="markdown-popout"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      aria-label="Markdown viewer"
    >
      <div
        className="markdown-popout-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Markdown viewer"
        title="Resize Markdown viewer"
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onResizeStart(event.clientX)
        }}
      />
      <div className="markdown-popout-header">
        <div className="markdown-popout-title-wrap">
          <div className="markdown-popout-title">{displayName(document)}</div>
          <div className="markdown-popout-path" title={displayPath(document)}>{displayPath(document)}</div>
        </div>
        <div className="markdown-popout-actions">
          {document.ok && (
            <div className="markdown-view-toggle" role="tablist" aria-label="Markdown view mode">
              <button
                className={viewMode === 'preview' ? 'active' : ''}
                onClick={() => onViewModeChange('preview')}
                role="tab"
                aria-selected={viewMode === 'preview'}
              >
                Preview
              </button>
              <button
                className={viewMode === 'source' ? 'active' : ''}
                onClick={() => onViewModeChange('source')}
                role="tab"
                aria-selected={viewMode === 'source'}
              >
                Markdown
              </button>
            </div>
          )}
          {document.ok && (
            <>
              <button
                className="markdown-icon-btn"
                onClick={() => {
                  void window.api.markdownOpen({ rawPath: document.path, cwd: document.directory }).then(onOpenResult)
                }}
                title="Refresh"
              >
                Refresh
              </button>
              <button className="markdown-icon-btn" onClick={() => window.api.openPath(document.path)} title="Open externally">Open</button>
            </>
          )}
          <button className="markdown-icon-btn" onClick={handleCollapse} title="Collapse Markdown">Collapse</button>
          <button className="markdown-icon-btn markdown-icon-btn--close" onClick={handleClose} title="Close Markdown">Close</button>
        </div>
      </div>

      {document.ok ? (
        viewMode === 'preview' ? (
          <div
            ref={previewRef}
            className="markdown-preview"
            onClick={handlePreviewClick}
            onScroll={(event) => { previewScrollRef.current = event.currentTarget.scrollTop }}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : (
          <pre
            ref={sourceRef}
            className="markdown-source"
            onScroll={(event) => { sourceScrollRef.current = event.currentTarget.scrollTop }}
          >
            <code>{document.markdown}</code>
          </pre>
        )
      ) : (
        <div className="markdown-error">
          <h2>Could not open Markdown</h2>
          <p>{document.error}</p>
          {document.path && (
            <button className="markdown-error-action" onClick={() => window.api.openPath(document.path!)}>
              Open externally
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
