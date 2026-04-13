const revealNodes = document.querySelectorAll('[data-reveal]')
const terminalLines = Array.from(document.querySelectorAll('[data-line]'))
const terminalStage = document.querySelector('.terminal-stage')
const terminalCard = document.querySelector('.terminal-card')

for (const node of revealNodes) {
  const delay = node.getAttribute('data-reveal-delay')
  if (delay) node.style.setProperty('--reveal-delay', `${delay}ms`)
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed')
        observer.unobserve(entry.target)
      }
    }
  },
  { threshold: 0.2 }
)

revealNodes.forEach((node) => observer.observe(node))

const phrases = [
  'Hi there, welcome to Emu.',
  'We built the best terminal experience ever.',
  'Emu is 10x more beautiful and feature-rich than your native macOS terminal.',
  'GPU rendering, unlimited tabs, split-screen mode, custom color palettes, and many other delightful features.',
  'This is everything you want your terminal to be, and nothing you don\'t.',
  '100% open-source.'
]

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const cursor = document.createElement('span')
cursor.className = 'terminal-cursor'
cursor.setAttribute('aria-hidden', 'true')
const actionButtons = Array.from(document.querySelectorAll('.terminal-actions a'))

const escapeHtml = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const highlightWords = (text) => {
  const replacements = [
    { pattern: /\bbest\b/g, value: 'best' },
    { pattern: /\b10x\b/g, value: '10x' },
    { pattern: /\beverything\b/g, value: 'everything' },
    { pattern: /\bnothing\b/g, value: 'nothing' },
  ]

  let html = escapeHtml(text)
  for (const { pattern, value } of replacements) {
    html = html.replace(pattern, `<span class="terminal-emphasis">${value}</span>`)
  }
  return html
}

const moveCursorTo = (line) => {
  if (!line) return
  line.appendChild(cursor)
}

if (terminalLines.length === phrases.length) {
  const typeLine = async (node, text) => {
    moveCursorTo(node)
    if (reducedMotion) {
      node.innerHTML = highlightWords(text)
      moveCursorTo(node)
      return
    }

    node.textContent = ''
    for (const char of text) {
      node.textContent = text.slice(0, node.textContent.length + 1)
      moveCursorTo(node)
      await new Promise((resolve) => window.setTimeout(resolve, 22))
    }
    node.innerHTML = highlightWords(text)
    moveCursorTo(node)
  }

  const run = async () => {
    for (let index = 0; index < terminalLines.length; index += 1) {
      await typeLine(terminalLines[index], phrases[index])
      await new Promise((resolve) => window.setTimeout(resolve, 360))
    }
  }

  window.setTimeout(() => {
    run()
  }, 300)
}

if (terminalStage && terminalCard && !reducedMotion) {
  const state = {
    x: 9,
    y: -12,
    lift: 10,
    scale: 1,
  }

  const target = {
    x: 9,
    y: -12,
    lift: 10,
    scale: 1,
  }

  const angledTarget = {
    x: 9,
    y: -12,
    lift: 10,
    scale: 1,
  }

  const flatTarget = {
    x: -9,
    y: 12,
    lift: -10,
    scale: 1,
  }

  const applyState = () => {
    terminalStage.style.setProperty('--tilt-x', `${state.x}deg`)
    terminalStage.style.setProperty('--tilt-y', `${state.y}deg`)
    terminalStage.style.setProperty('--lift', `${state.lift}px`)
    terminalStage.style.setProperty('--scale', `${state.scale}`)
  }

  let isInside = false
  let isButtonHovering = false

  const setTarget = (source) => {
    target.x = source.x
    target.y = source.y
    target.lift = source.lift
    target.scale = source.scale
  }

  const setTargetFromEvent = (event) => {
    const rect = terminalStage.getBoundingClientRect()
    const bodyRect = terminalCard.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height
    const shellY = event.clientY - bodyRect.top
    const activeZoneHeight = Math.max(bodyRect.height * 0.78, 1)

    if (isButtonHovering) return
    if (shellY > activeZoneHeight) return

    const centerX = x - 0.5
    const centerY = y - 0.5

    angledTarget.x = centerY * -18
    angledTarget.y = centerX * 24
    angledTarget.lift = 8 + Math.abs(centerX) * 12 + Math.abs(centerY) * 12
    angledTarget.scale = 1 + Math.min(0.03, (Math.abs(centerX) + Math.abs(centerY)) * 0.012)
    setTarget(angledTarget)
    isInside = true
  }

  const resetTarget = () => {
    setTarget(angledTarget)
    isInside = false
  }

  actionButtons.forEach((button) => {
    button.addEventListener('pointerenter', () => {
      isButtonHovering = true
      setTarget(flatTarget)
    })

    button.addEventListener('pointerleave', () => {
      isButtonHovering = false
      setTarget(angledTarget)
    })
  })

  window.addEventListener('mousemove', setTargetFromEvent)
  window.addEventListener('mouseleave', resetTarget)
  terminalStage.addEventListener('pointerleave', resetTarget)
  terminalStage.addEventListener('pointerenter', (event) => setTargetFromEvent(event))

  const tick = () => {
    if (!isInside || isButtonHovering) {
      setTarget(isButtonHovering ? flatTarget : angledTarget)
    }

    state.x += (target.x - state.x) * 0.08
    state.y += (target.y - state.y) * 0.08
    state.lift += (target.lift - state.lift) * 0.08
    state.scale += (target.scale - state.scale) * 0.08
    applyState()
    window.requestAnimationFrame(tick)
  }

  window.addEventListener('mouseout', (event) => {
    if (!event.relatedTarget) {
      isInside = false
    }
  })

  applyState()
  window.requestAnimationFrame(tick)
}
