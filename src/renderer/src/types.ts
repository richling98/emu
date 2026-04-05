export type MessageRole = 'input' | 'output'

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string // input: plain text command; output: raw string with ANSI codes
  timestamp: Date
}
