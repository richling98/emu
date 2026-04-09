import type { ITheme } from '@xterm/xterm'

export interface AppTheme {
  id: string
  name: string
  // CSS custom properties applied to :root
  bgBase: string      // terminal area background
  bgPanel: string     // sidebar / drawer panels
  bgTitlebar: string  // titlebar
  accent: string      // primary accent (tabs, active states, links)
  accentAlt: string   // secondary accent (highlights, cursors)
  // xterm.js terminal colors
  terminal: ITheme
}

export const THEMES: AppTheme[] = [
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin',
    bgBase: '#1e1e2e',
    bgPanel: 'rgba(22, 22, 40, 0.42)',
    bgTitlebar: 'rgba(28, 28, 45, 0.45)',
    accent: '#b4befe',
    accentAlt: '#cba6f7',
    terminal: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      cursorAccent: '#1e1e2e',
      selectionBackground: 'rgba(88, 91, 112, 0.5)',
      black: '#45475a',   brightBlack: '#585b70',
      red: '#f38ba8',     brightRed: '#f38ba8',
      green: '#a6e3a1',   brightGreen: '#a6e3a1',
      yellow: '#f9e2af',  brightYellow: '#f9e2af',
      blue: '#89b4fa',    brightBlue: '#89b4fa',
      magenta: '#cba6f7', brightMagenta: '#cba6f7',
      cyan: '#89dceb',    brightCyan: '#89dceb',
      white: '#bac2de',   brightWhite: '#a6adc8',
    },
  },
  {
    id: 'matrix',
    name: 'Matrix',
    bgBase: '#000000',
    bgPanel: 'rgba(0, 8, 0, 0.42)',
    bgTitlebar: 'rgba(0, 6, 0, 0.45)',
    accent: '#00ff41',
    accentAlt: '#00cc33',
    terminal: {
      background: '#000000',
      foreground: '#00ff41',
      cursor: '#00ff41',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(0, 255, 65, 0.2)',
      black: '#000000',   brightBlack: '#003b00',
      red: '#ff2222',     brightRed: '#ff5555',
      green: '#00ff41',   brightGreen: '#69ff47',
      yellow: '#ffe000',  brightYellow: '#ffff55',
      blue: '#0088ff',    brightBlue: '#44aaff',
      magenta: '#cc00ff', brightMagenta: '#ee44ff',
      cyan: '#00ffcc',    brightCyan: '#55ffee',
      white: '#00cc33',   brightWhite: '#00ff41',
    },
  },
  {
    id: 'cobalt2',
    name: 'Francisco',
    bgBase: '#193549',
    bgPanel: 'rgba(15, 31, 45, 0.42)',
    bgTitlebar: 'rgba(18, 35, 50, 0.45)',
    accent: '#ffc600',
    accentAlt: '#ff9d00',
    terminal: {
      background: '#193549',
      foreground: '#ffffff',
      cursor: '#ffc600',
      cursorAccent: '#193549',
      selectionBackground: 'rgba(38, 79, 120, 0.6)',
      black: '#3d424d',   brightBlack: '#6a7d8b',
      red: '#ff3a3a',     brightRed: '#ff6d6b',
      green: '#3ad900',   brightGreen: '#3ad900',
      yellow: '#ffc600',  brightYellow: '#ffd242',
      blue: '#0088ff',    brightBlue: '#4ab4ff',
      magenta: '#9d00ff', brightMagenta: '#b963ff',
      cyan: '#80fcff',    brightCyan: '#80fcff',
      white: '#ffffff',   brightWhite: '#ffffff',
    },
  },
  {
    id: 'synthwave',
    name: 'Haze',
    bgBase: '#262335',
    bgPanel: 'rgba(28, 25, 44, 0.42)',
    bgTitlebar: 'rgba(30, 26, 48, 0.45)',
    accent: '#ff7edb',
    accentAlt: '#36f9f6',
    terminal: {
      background: '#262335',
      foreground: '#ffffff',
      cursor: '#ff7edb',
      cursorAccent: '#262335',
      selectionBackground: 'rgba(73, 84, 149, 0.5)',
      black: '#495495',   brightBlack: '#848bbd',
      red: '#f97e72',     brightRed: '#f97e72',
      green: '#72f1b8',   brightGreen: '#72f1b8',
      yellow: '#fede5d',  brightYellow: '#fede5d',
      blue: '#6d77b3',    brightBlue: '#6d77b3',
      magenta: '#ff7edb', brightMagenta: '#ff7edb',
      cyan: '#36f9f6',    brightCyan: '#36f9f6',
      white: '#f0eff1',   brightWhite: '#fefefe',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Mocha',
    bgBase: '#282828',
    bgPanel: 'rgba(29, 29, 29, 0.42)',
    bgTitlebar: 'rgba(30, 28, 26, 0.45)',
    accent: '#fabd2f',
    accentAlt: '#fe8019',
    terminal: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      cursorAccent: '#282828',
      selectionBackground: 'rgba(60, 56, 54, 0.5)',
      black: '#282828',   brightBlack: '#928374',
      red: '#cc241d',     brightRed: '#fb4934',
      green: '#98971a',   brightGreen: '#b8bb26',
      yellow: '#d79921',  brightYellow: '#fabd2f',
      blue: '#458588',    brightBlue: '#83a598',
      magenta: '#b16286', brightMagenta: '#d3869b',
      cyan: '#689d6a',    brightCyan: '#8ec07c',
      white: '#a89984',   brightWhite: '#ebdbb2',
    },
  },
  {
    id: 'monokai-pro',
    name: 'Monokai',
    bgBase: '#2d2a2e',
    bgPanel: 'rgba(32, 29, 32, 0.42)',
    bgTitlebar: 'rgba(34, 31, 34, 0.45)',
    accent: '#ffd866',
    accentAlt: '#ff6188',
    terminal: {
      background: '#2d2a2e',
      foreground: '#fcfcfa',
      cursor: '#fcfcfa',
      cursorAccent: '#2d2a2e',
      selectionBackground: 'rgba(64, 61, 65, 0.5)',
      black: '#403e41',   brightBlack: '#727072',
      red: '#ff6188',     brightRed: '#ff6188',
      green: '#a9dc76',   brightGreen: '#a9dc76',
      yellow: '#ffd866',  brightYellow: '#ffd866',
      blue: '#78dce8',    brightBlue: '#78dce8',
      magenta: '#ab9df2', brightMagenta: '#ab9df2',
      cyan: '#78dce8',    brightCyan: '#78dce8',
      white: '#fcfcfa',   brightWhite: '#ffffff',
    },
  },
]

export const DEFAULT_THEME_ID = 'catppuccin-mocha'

export function getTheme(id: string): AppTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** Apply a theme by writing CSS custom properties to the document root. */
export function applyTheme(theme: AppTheme): void {
  const root = document.documentElement
  root.style.setProperty('--bg-base', theme.bgBase)
  root.style.setProperty('--bg-panel', theme.bgPanel)
  root.style.setProperty('--bg-titlebar', theme.bgTitlebar)
  root.style.setProperty('--accent', theme.accent)
  root.style.setProperty('--accent-alt', theme.accentAlt)
}

// Apply saved theme synchronously before first render to avoid any flash
const _savedId = localStorage.getItem('emmy-theme-id') ?? DEFAULT_THEME_ID
applyTheme(getTheme(_savedId))
