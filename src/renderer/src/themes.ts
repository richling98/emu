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
    name: 'Catppuccin Mocha',
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
    id: 'tokyo-night',
    name: 'Tokyo Night',
    bgBase: '#1a1b26',
    bgPanel: 'rgba(19, 20, 34, 0.42)',
    bgTitlebar: 'rgba(20, 21, 38, 0.45)',
    accent: '#7aa2f7',
    accentAlt: '#bb9af7',
    terminal: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: 'rgba(65, 72, 104, 0.5)',
      black: '#15161e',   brightBlack: '#414868',
      red: '#f7768e',     brightRed: '#f7768e',
      green: '#9ece6a',   brightGreen: '#9ece6a',
      yellow: '#e0af68',  brightYellow: '#e0af68',
      blue: '#7aa2f7',    brightBlue: '#7aa2f7',
      magenta: '#bb9af7', brightMagenta: '#bb9af7',
      cyan: '#7dcfff',    brightCyan: '#7dcfff',
      white: '#a9b1d6',   brightWhite: '#c0caf5',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    bgBase: '#282a36',
    bgPanel: 'rgba(30, 31, 42, 0.42)',
    bgTitlebar: 'rgba(32, 34, 46, 0.45)',
    accent: '#bd93f9',
    accentAlt: '#ff79c6',
    terminal: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      cursorAccent: '#282a36',
      selectionBackground: 'rgba(68, 71, 90, 0.5)',
      black: '#21222c',   brightBlack: '#6272a4',
      red: '#ff5555',     brightRed: '#ff6e6e',
      green: '#50fa7b',   brightGreen: '#69ff94',
      yellow: '#f1fa8c',  brightYellow: '#ffffa5',
      blue: '#6272a4',    brightBlue: '#6272a4',
      magenta: '#ff79c6', brightMagenta: '#ff92df',
      cyan: '#8be9fd',    brightCyan: '#a4ffff',
      white: '#f8f8f2',   brightWhite: '#ffffff',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    bgBase: '#2e3440',
    bgPanel: 'rgba(36, 41, 51, 0.42)',
    bgTitlebar: 'rgba(36, 41, 55, 0.45)',
    accent: '#88c0d0',
    accentAlt: '#81a1c1',
    terminal: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      cursorAccent: '#2e3440',
      selectionBackground: 'rgba(67, 76, 94, 0.5)',
      black: '#3b4252',   brightBlack: '#4c566a',
      red: '#bf616a',     brightRed: '#bf616a',
      green: '#a3be8c',   brightGreen: '#a3be8c',
      yellow: '#ebcb8b',  brightYellow: '#ebcb8b',
      blue: '#81a1c1',    brightBlue: '#81a1c1',
      magenta: '#b48ead', brightMagenta: '#b48ead',
      cyan: '#88c0d0',    brightCyan: '#8fbcbb',
      white: '#e5e9f0',   brightWhite: '#eceff4',
    },
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
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
    id: 'rose-pine',
    name: 'Rosé Pine',
    bgBase: '#191724',
    bgPanel: 'rgba(20, 19, 28, 0.42)',
    bgTitlebar: 'rgba(22, 21, 33, 0.45)',
    accent: '#ebbcba',
    accentAlt: '#f6c177',
    terminal: {
      background: '#191724',
      foreground: '#e0def4',
      cursor: '#f6c177',
      cursorAccent: '#191724',
      selectionBackground: 'rgba(64, 61, 82, 0.5)',
      black: '#26233a',   brightBlack: '#6e6a86',
      red: '#eb6f92',     brightRed: '#eb6f92',
      green: '#31748f',   brightGreen: '#9ccfd8',
      yellow: '#f6c177',  brightYellow: '#f6c177',
      blue: '#9ccfd8',    brightBlue: '#9ccfd8',
      magenta: '#c4a7e7', brightMagenta: '#c4a7e7',
      cyan: '#ebbcba',    brightCyan: '#ebbcba',
      white: '#e0def4',   brightWhite: '#e0def4',
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
