"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type ChatMessage = {
  type: "message";
  id: string;
  content: string;
  timestamp: string;
  sender: {
    id: string;
    name: string;
  };
};

type ServerMessage =
  | ChatMessage
  | {
      type: "history";
      messages: ChatMessage[];
    }
  | {
      type: "error";
      code?: string;
      message: string;
    };

const MAX_MESSAGE_LENGTH = 2000;
const MAX_RECONNECT_DELAY = 10_000;

export default function ChatClient() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<
    "Connecting" | "Connected" | "Reconnecting" | "Disconnected"
  >("Connecting");
  const [error, setError] = useState("");
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stableConnectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reconnectAttemptRef = useRef(0);
  const isMountedRef = useRef(false);
  const hasReceivedHistoryRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    isNearBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  const mergeMessages = useCallback((incoming: ChatMessage[]) => {
    setMessages((previous) => {
      const byId = new Map(previous.map((message) => [message.id, message]));
      for (const message of incoming) {
        byId.set(message.id, message);
      }
      return [...byId.values()].sort((a, b) => {
        const timeDifference =
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        return timeDifference || a.id.localeCompare(b.id);
      });
    });
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    const connect = () => {
      if (!isMountedRef.current) return;
      const currentSocket = socketRef.current;
      if (
        currentSocket &&
        (currentSocket.readyState === WebSocket.OPEN ||
          currentSocket.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      setStatus(
        reconnectAttemptRef.current > 0 ? "Reconnecting" : "Connecting",
      );
      const socket = new WebSocket("ws://localhost:8080");
      socketRef.current = socket;

      socket.onopen = () => {
        if (socketRef.current !== socket || !isMountedRef.current) return;
        if (stableConnectionTimerRef.current) {
          clearTimeout(stableConnectionTimerRef.current);
        }
        stableConnectionTimerRef.current = setTimeout(() => {
          if (socketRef.current === socket && isMountedRef.current) {
            reconnectAttemptRef.current = 0;
          }
          stableConnectionTimerRef.current = null;
        }, 10_000);
        setStatus("Connected");
        setError("");
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (stableConnectionTimerRef.current) {
          clearTimeout(stableConnectionTimerRef.current);
          stableConnectionTimerRef.current = null;
        }
        if (!isMountedRef.current) return;

        const delay = Math.min(
          1000 * 2 ** reconnectAttemptRef.current,
          MAX_RECONNECT_DELAY,
        );
        reconnectAttemptRef.current += 1;
        setStatus("Reconnecting");
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      };
      socket.onerror = () => {
        if (socketRef.current === socket && isMountedRef.current) {
          setError("Connection lost. Trying to reconnect...");
        }
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        if (socketRef.current !== socket || !isMountedRef.current) return;
        try {
          const message: ServerMessage = JSON.parse(event.data);
          if (message.type === "history") {
            const shouldScroll =
              !hasReceivedHistoryRef.current || isNearBottomRef.current;
            hasReceivedHistoryRef.current = true;
            mergeMessages(message.messages);
            if (shouldScroll) {
              requestAnimationFrame(() => scrollToLatest("auto"));
            }
          } else if (message.type === "message") {
            const shouldScroll = isNearBottomRef.current;
            mergeMessages([message]);
            if (shouldScroll) {
              requestAnimationFrame(() => scrollToLatest());
            } else {
              setHasNewMessages(true);
            }
          } else if (message.type === "error") {
            setError(message.message);
          }
        } catch {
          setError("Received an invalid response from the chat server.");
        }
      };
    };

    connect();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (stableConnectionTimerRef.current) {
        clearTimeout(stableConnectionTimerRef.current);
        stableConnectionTimerRef.current = null;
      }
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [mergeMessages, scrollToLatest]);

  function handleScroll() {
    const container = messagesRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 64;
    if (isNearBottomRef.current) {
      setHasNewMessages(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = text.trim();
    const socket = socketRef.current;

    if (!content) {
      setError("Message cannot be empty.");
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      setError("Message cannot exceed 2000 characters.");
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("You are disconnected. Please wait for reconnection.");
      return;
    }

    try {
      socket.send(content);
      setText("");
      setError("");
    } catch {
      setError("Unable to send your message. Please try again.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col p-4">
      <header className="border-b pb-4">
        <h1 className="text-2xl font-bold">ChatSpace</h1>
        <p className="text-sm text-gray-500">Shared chat room · {status}</p>
      </header>

      <section
        ref={messagesRef}
        onScroll={handleScroll}
        aria-live="polite"
        aria-label="Chat messages"
        className="flex-1 space-y-3 overflow-y-auto py-4"
      >
        {messages.length === 0 && (
          <p className="text-gray-500">No messages yet. Say hello!</p>
        )}
        {messages.map((message) => (
          <article key={message.id} className="rounded-lg border p-3">
            <p className="mb-1 text-sm font-semibold">{message.sender.name}</p>
            <p className="break-words">{message.content}</p>
            <time className="mt-2 block text-xs text-gray-500">
              {new Date(message.timestamp).toLocaleTimeString()}
            </time>
          </article>
        ))}
        <div ref={bottomRef} />
      </section>

      {hasNewMessages && (
        <button
          type="button"
          onClick={() => scrollToLatest()}
          className="self-center rounded-full bg-blue-600 px-4 py-2 text-sm text-white"
        >
          Jump to latest
        </button>
      )}

      {error && (
        <p role="alert" className="pt-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="flex gap-2 border-t pt-4">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Type a message..."
          aria-label="Message"
          maxLength={MAX_MESSAGE_LENGTH}
          className="min-w-0 flex-1 rounded-md border p-3"
        />
        <button
          type="submit"
          disabled={!text.trim() || status !== "Connected"}
          className="rounded-md bg-black px-5 text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </main>
  );
}
