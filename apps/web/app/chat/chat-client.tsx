"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type UserResult = {
  id: string;
  name: string;
  email: string;
};

type ChatMessage = {
  id: string;
  content: string;
  timestamp: string;
  sender: {
    id: string;
    name: string;
  };
};

type Conversation = {
  id: string;
  participant: UserResult;
  latestMessage: {
    id: string;
    content: string;
    timestamp: string;
    senderId: string;
  } | null;
};

type ServerMessage =
  | {
      type: "history";
      conversationId: string;
      messages: ChatMessage[];
    }
  | ({
      type: "message";
      conversationId: string;
    } & ChatMessage)
  | {
      type: "message_sent";
      conversationId: string;
      clientMessageId: string;
      messageId: string;
      message: ChatMessage;
    }
  | {
      type: "error";
      message: string;
      clientMessageId?: string;
    };

const MAX_MESSAGE_LENGTH = 2000;
const MAX_RECONNECT_DELAY = 10_000;

type PendingMessage = {
  conversationId: string;
  clientMessageId: string;
  content: string;
  draftRevision: number;
};

function sortMessages(messages: ChatMessage[]) {
  return [...messages].sort((first, second) => {
    const timeDifference =
      new Date(first.timestamp).getTime() -
      new Date(second.timestamp).getTime();
    return timeDifference || first.id.localeCompare(second.id);
  });
}

export default function ChatClient({
  currentUserId,
}: {
  currentUserId: string;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [messagesByConversation, setMessagesByConversation] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [search, setSearch] = useState("");
  const [users, setUsers] = useState<UserResult[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<
    "Connecting" | "Connected" | "Reconnecting" | "Disconnected"
  >("Connecting");
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [error, setError] = useState("");
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const [pendingMessage, setPendingMessage] = useState<PendingMessage | null>(
    null,
  );
  const socketRef = useRef<WebSocket | null>(null);
  const selectedConversationRef = useRef("");
  const pendingMessageRef = useRef<PendingMessage | null>(null);
  const draftsRef = useRef(new Map<string, string>());
  const draftRevisionsRef = useRef(new Map<string, number>());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const isMountedRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const selectedConversation = conversations.find(
    (conversation) => conversation.id === selectedConversationId,
  );
  const messages = messagesByConversation[selectedConversationId] ?? [];

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior, block: "end" });
    isNearBottomRef.current = true;
    setHasNewMessages(false);
  }, []);

  const sendEvent = useCallback((event: object) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(event));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations");
      const data: { conversations?: Conversation[]; error?: string } =
        await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Unable to load conversations.");
      setConversations(data.conversations ?? []);
      setSelectedConversationId((current) => {
        if (current && data.conversations?.some(({ id }) => id === current)) {
          return current;
        }
        return data.conversations?.[0]?.id ?? "";
      });
    } catch (loadError) {
      console.error("Conversation loading failed:", loadError);
      setError("Unable to load your conversations.");
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    selectedConversationRef.current = selectedConversationId;
    setHasNewMessages(false);
    if (selectedConversationId) {
      sendEvent({
        type: "join_conversation",
        conversationId: selectedConversationId,
      });
    }
  }, [selectedConversationId, sendEvent]);

  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setUsers([]);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/users/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const data: { users?: UserResult[]; error?: string } =
            await response.json();
          if (!response.ok) throw new Error(data.error ?? "Search failed.");
          setUsers(data.users ?? []);
        })
        .catch((searchError: unknown) => {
          if (!controller.signal.aborted) {
            console.error("User search failed:", searchError);
            setError("Unable to search users.");
          }
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

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
        setStatus("Connected");
        setError("");
        reconnectAttemptRef.current = 0;
        const conversationId = selectedConversationRef.current;
        if (conversationId) {
          socket.send(
            JSON.stringify({ type: "join_conversation", conversationId }),
          );
        }
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        if (!isMountedRef.current) return;
        if (pendingMessageRef.current) {
          pendingMessageRef.current = null;
          setPendingMessage(null);
          setError(
            "Message delivery is uncertain because the connection was lost. " +
              "Your text was kept; check history before retrying.",
          );
        }
        const delay = Math.min(
          1000 * 2 ** reconnectAttemptRef.current,
          MAX_RECONNECT_DELAY,
        );
        reconnectAttemptRef.current += 1;
        setStatus("Reconnecting");
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
            setMessagesByConversation((previous) => {
              const existing = previous[message.conversationId] ?? [];
              const byId = new Map(existing.map((item) => [item.id, item]));
              for (const historyMessage of message.messages) {
                byId.set(historyMessage.id, historyMessage);
              }
              return {
                ...previous,
                [message.conversationId]: sortMessages([...byId.values()]),
              };
            });
            if (
              message.conversationId === selectedConversationRef.current &&
              isNearBottomRef.current
            ) {
              requestAnimationFrame(() => scrollToLatest("auto"));
            }
          } else if (message.type === "message") {
            setMessagesByConversation((previous) => {
              const existing = previous[message.conversationId] ?? [];
              const byId = new Map(existing.map((item) => [item.id, item]));
              byId.set(message.id, message);
              return {
                ...previous,
                [message.conversationId]: sortMessages([...byId.values()]),
              };
            });
            setConversations((previous) =>
              previous
                .map((conversation) =>
                  conversation.id === message.conversationId
                    ? {
                        ...conversation,
                        latestMessage: {
                          id: message.id,
                          content: message.content,
                          timestamp: message.timestamp,
                          senderId: message.sender.id,
                        },
                      }
                    : conversation,
                )
                .sort((first, second) =>
                  (second.latestMessage?.timestamp ?? "").localeCompare(
                    first.latestMessage?.timestamp ?? "",
                  ),
                ),
            );
            if (
              message.conversationId === selectedConversationRef.current &&
              isNearBottomRef.current
            ) {
              requestAnimationFrame(() => scrollToLatest());
            } else if (
              message.conversationId === selectedConversationRef.current
            ) {
              setHasNewMessages(true);
            }
          } else if (message.type === "message_sent") {
            const pending = pendingMessageRef.current;
            if (
              pending?.conversationId !== message.conversationId ||
              pending.clientMessageId !== message.clientMessageId
            ) {
              return;
            }

            setMessagesByConversation((previous) => {
              const existing = previous[message.conversationId] ?? [];
              const byId = new Map(existing.map((item) => [item.id, item]));
              byId.set(message.messageId, message.message);
              return {
                ...previous,
                [message.conversationId]: sortMessages([...byId.values()]),
              };
            });
            pendingMessageRef.current = null;
            setPendingMessage(null);
            const currentDraftRevision =
              draftRevisionsRef.current.get(pending.conversationId) ?? 0;
            if (currentDraftRevision === pending.draftRevision) {
              if (selectedConversationRef.current === pending.conversationId) {
                setText("");
              }
              draftsRef.current.delete(pending.conversationId);
            }
            setError("");
          } else if (message.type === "error") {
            const pending = pendingMessageRef.current;
            if (
              pending &&
              message.clientMessageId === pending.clientMessageId
            ) {
              pendingMessageRef.current = null;
              setPendingMessage(null);
            }
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
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [scrollToLatest]);

  function handleScroll() {
    const container = messagesRef.current;
    if (!container) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 64;
    if (isNearBottomRef.current) setHasNewMessages(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = text.trim();
    if (pendingMessageRef.current) {
      setError("Please wait for the current message to be confirmed.");
      return;
    }
    if (!content) {
      setError("Message cannot be empty.");
      return;
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      setError("Message cannot exceed 2000 characters.");
      return;
    }
    if (!selectedConversationId) {
      setError("Select a conversation before sending.");
      return;
    }
    const clientMessageId = crypto.randomUUID();
    const pending: PendingMessage = {
      conversationId: selectedConversationId,
      clientMessageId,
      content,
      draftRevision: draftRevisionsRef.current.get(selectedConversationId) ?? 0,
    };
    if (
      !sendEvent({
        type: "send_message",
        conversationId: selectedConversationId,
        clientMessageId,
        content,
      })
    ) {
      setError("You are disconnected. Please wait for reconnection.");
      return;
    }
    pendingMessageRef.current = pending;
    setPendingMessage(pending);
    setError("");
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function startConversation(user: UserResult) {
    setError("");
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data: { conversation?: Conversation; error?: string } =
        await response.json();
      if (!response.ok || !data.conversation) {
        throw new Error(data.error ?? "Unable to start conversation.");
      }

      setSearch("");
      setUsers([]);
      await loadConversations();
      selectConversation(data.conversation.id);
    } catch (conversationError) {
      console.error("Conversation creation failed:", conversationError);
      setError("Unable to start this conversation.");
    }
  }

  function selectConversation(conversationId: string) {
    if (conversationId === selectedConversationId) return;
    if (selectedConversationId) {
      draftsRef.current.set(selectedConversationId, text);
      sendEvent({
        type: "leave_conversation",
        conversationId: selectedConversationId,
      });
    }
    setSelectedConversationId(conversationId);
    setText(draftsRef.current.get(conversationId) ?? "");
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col p-4">
      <header className="border-b pb-4">
        <h1 className="text-2xl font-bold">ChatSpace</h1>
        <p className="text-sm text-gray-500">Private messages · {status}</p>
      </header>

      <section className="mt-4 grid min-h-[70vh] flex-1 grid-cols-1 overflow-hidden rounded-xl border md:grid-cols-[18rem_1fr]">
        <aside className="border-b p-4 md:border-b-0 md:border-r">
          <label className="block text-sm font-medium" htmlFor="user-search">
            Find people
          </label>
          <input
            id="user-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name or email"
            className="mt-2 w-full rounded-md border p-2"
          />
          {users.length > 0 && (
            <div className="mt-2 space-y-1">
              {users.map((user) => (
                <button
                  type="button"
                  key={user.id}
                  onClick={() => void startConversation(user)}
                  className="w-full rounded-md border p-2 text-left text-sm hover:bg-gray-50"
                >
                  <span className="block font-medium">{user.name}</span>
                  <span className="block text-gray-500">{user.email}</span>
                </button>
              ))}
            </div>
          )}

          <h2 className="mt-6 text-sm font-semibold">Conversations</h2>
          <div className="mt-2 space-y-1">
            {loadingConversations && (
              <p className="text-sm text-gray-500">Loading conversations...</p>
            )}
            {!loadingConversations && conversations.length === 0 && (
              <p className="text-sm text-gray-500">
                Search for someone to begin.
              </p>
            )}
            {conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                onClick={() => selectConversation(conversation.id)}
                className={`w-full rounded-md p-3 text-left ${
                  conversation.id === selectedConversationId
                    ? "bg-black text-white"
                    : "hover:bg-gray-100"
                }`}
              >
                <span className="block font-medium">
                  {conversation.participant.name}
                </span>
                <span className="block truncate text-sm opacity-70">
                  {conversation.latestMessage?.content ?? "No messages yet"}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div className="flex min-h-[28rem] flex-col">
          {!selectedConversation ? (
            <div className="flex flex-1 items-center justify-center p-6 text-gray-500">
              Select a conversation or search for someone to begin.
            </div>
          ) : (
            <>
              <header className="border-b p-4">
                <h2 className="font-semibold">
                  {selectedConversation.participant.name}
                </h2>
                <p className="text-sm text-gray-500">
                  {selectedConversation.participant.email}
                </p>
              </header>
              <div
                ref={messagesRef}
                onScroll={handleScroll}
                aria-live="polite"
                aria-label="Private messages"
                className="flex-1 space-y-3 overflow-y-auto p-4"
              >
                {messages.length === 0 && (
                  <p className="text-gray-500">No messages yet. Say hello!</p>
                )}
                {messages.map((message) => {
                  const ownMessage = message.sender.id === currentUserId;
                  return (
                    <article
                      key={message.id}
                      className={`max-w-[85%] rounded-lg border p-3 ${
                        ownMessage ? "ml-auto bg-blue-50" : "mr-auto"
                      }`}
                    >
                      {!ownMessage && (
                        <p className="mb-1 text-sm font-semibold">
                          {message.sender.name}
                        </p>
                      )}
                      <p className="whitespace-pre-wrap break-words">
                        {message.content}
                      </p>
                      <time className="mt-2 block text-xs text-gray-500">
                        {new Date(message.timestamp).toLocaleTimeString()}
                      </time>
                    </article>
                  );
                })}
                <div ref={bottomRef} />
              </div>
              {hasNewMessages && (
                <button
                  type="button"
                  onClick={() => scrollToLatest()}
                  className="self-center rounded-full bg-blue-600 px-4 py-2 text-sm text-white"
                >
                  Jump to latest
                </button>
              )}
              {pendingMessage && (
                <p className="px-4 pt-2 text-sm text-gray-500">
                  Waiting for delivery confirmation...
                </p>
              )}
              <form onSubmit={handleSubmit} className="flex gap-2 border-t p-4">
                <textarea
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    if (selectedConversationId) {
                      const nextRevision =
                        (draftRevisionsRef.current.get(
                          selectedConversationId,
                        ) ?? 0) + 1;
                      draftRevisionsRef.current.set(
                        selectedConversationId,
                        nextRevision,
                      );
                      draftsRef.current.set(
                        selectedConversationId,
                        event.target.value,
                      );
                    }
                  }}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="Type a message..."
                  aria-label="Message"
                  maxLength={MAX_MESSAGE_LENGTH}
                  rows={2}
                  className="min-w-0 flex-1 resize-none rounded-md border p-3"
                />
                <button
                  type="submit"
                  disabled={
                    !text.trim() ||
                    status !== "Connected" ||
                    pendingMessage !== null
                  }
                  className="rounded-md bg-black px-5 text-white disabled:opacity-50"
                >
                  Send
                </button>
              </form>
            </>
          )}
        </div>
      </section>

      {error && (
        <p role="alert" className="pt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </main>
  );
}
