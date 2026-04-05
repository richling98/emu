import { useEffect, useRef } from 'react'
import type { ChatMessage } from '../types'
import MessageBubble from './MessageBubble'
import './ChatView.css'

interface Props {
  messages: ChatMessage[]
  liveInput: string
}

export default function ChatView({ messages, liveInput }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom whenever messages or live input changes
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, liveInput])

  return (
    <div className="chat-view">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">Start typing a command below</div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={msg.id} message={msg} isLast={i === messages.length - 1} />
        ))}
        {/* Live input indicator while user is typing */}
        {liveInput && (
          <div className="bubble-row bubble-row--input">
            <div className="bubble bubble--input bubble--live">
              <span className="bubble-prompt">$</span>
              <span className="bubble-command">{liveInput}</span>
              <span className="live-cursor" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
