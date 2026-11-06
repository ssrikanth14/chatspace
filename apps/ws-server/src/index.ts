import dotenv from "dotenv";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { getToken } from "next-auth/jwt";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

import { parse } from "cookie";

const currentDir = dirname(fileURLToPath(import.meta.url));

dotenv.config({
  path: resolve(currentDir, "../../web/.env.local"),
});

dotenv.config({
  path: resolve(currentDir, "../../../.env"),
});

const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET;

if (!NEXTAUTH_SECRET) {
  throw new Error("NEXTAUTH_SECRET is missing from the environment.");
}
const { prisma } = await import("@chatspace/db");
const PORT = 8080;
const ALLOWED_ORIGIN = "http://localhost:3000";
const LEGACY_CONVERSATION_KEY = "legacy-shared-room";

const server = createServer((req, res) => {
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
});

function sendError(
  socket: WebSocket,
  code: string,
  message: string,
  clientMessageId?: string,
) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "error",
        code,
        message,
        ...(clientMessageId ? { clientMessageId } : {}),
      }),
    );
  }
}

function rejectUpgrade(
  socket: Duplex,
  status: "401 Unauthorized" | "403 Forbidden" | "500 Internal Server Error",
) {
  if (socket.destroyed) return;

  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

// Store only server-verified identity and server-authorized subscriptions.
const authenticatedUsers = new WeakMap<WebSocket, string>();
const subscribedConversations = new WeakMap<WebSocket, Set<string>>();
const MAX_CLIENT_MESSAGE_ID_LENGTH = 100;

server.on("upgrade", (req, socket, head) => {
  void (async () => {
    // Only accept connections from our Next.js application.
    if (req.headers.origin !== ALLOWED_ORIGIN) {
      rejectUpgrade(socket, "403 Forbidden");
      return;
    }
    const requestWithCookies = Object.assign(req, {
      cookies: parse(req.headers.cookie ?? ""),
    });
    const token = await getToken({
      req: requestWithCookies,
      secret: NEXTAUTH_SECRET,
      secureCookie: false,
      cookieName: "next-auth.session-token",
    });
    if (!token?.sub) {
      console.log("Rejecting WebSocket: invalid or missing session");
      rejectUpgrade(socket, "401 Unauthorized");
      return;
    }

    // Upgrade only after successful authentication.
    wss.handleUpgrade(req, socket, head, (ws) => {
      authenticatedUsers.set(ws, token.sub!);
      wss.emit("connection", ws, req);
    });
  })().catch((error: unknown) => {
    console.error("WebSocket authentication failed:", error);

    rejectUpgrade(socket, "500 Internal Server Error");
  });
});

wss.on("connection", (socket: WebSocket) => {
  const userId = authenticatedUsers.get(socket);

  if (!userId) {
    socket.close(1008, "Authentication required");
    return;
  }

  const subscriptions = new Set<string>();
  subscribedConversations.set(socket, subscriptions);
  console.log("Authenticated client connected");

  socket.on("message", async (data, isBinary) => {
    let clientMessageId: string | undefined;
    try {
      if (isBinary) {
        sendError(socket, "INVALID_PAYLOAD", "Message payload must be text.");
        return;
      }

      const parsed: unknown = JSON.parse(data.toString());
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("type" in parsed)
      ) {
        sendError(socket, "INVALID_PAYLOAD", "Invalid event payload.");
        return;
      }

      if (
        parsed.type !== "join_conversation" &&
        parsed.type !== "leave_conversation" &&
        parsed.type !== "send_message"
      ) {
        sendError(socket, "INVALID_EVENT", "Unsupported event type.");
        return;
      }

      if (parsed.type === "send_message") {
        const candidate =
          "clientMessageId" in parsed ? parsed.clientMessageId : undefined;
        if (
          typeof candidate === "string" &&
          candidate.trim() &&
          candidate.length <= MAX_CLIENT_MESSAGE_ID_LENGTH
        ) {
          clientMessageId = candidate;
        }
        if (
          typeof candidate !== "string" ||
          !candidate.trim() ||
          candidate.length > MAX_CLIENT_MESSAGE_ID_LENGTH
        ) {
          sendError(
            socket,
            "INVALID_CLIENT_MESSAGE_ID",
            "A valid client message ID is required.",
            clientMessageId,
          );
          return;
        }
      }

      if (
        !("conversationId" in parsed) ||
        typeof parsed.conversationId !== "string" ||
        !parsed.conversationId.trim() ||
        parsed.conversationId.length > 100
      ) {
        sendError(
          socket,
          "INVALID_CONVERSATION",
          "A valid conversation is required.",
          clientMessageId,
        );
        return;
      }

      const conversationId = parsed.conversationId.trim();

      if (parsed.type === "leave_conversation") {
        subscriptions.delete(conversationId);
        socket.send(
          JSON.stringify({ type: "left_conversation", conversationId }),
        );
        return;
      }

      const membership = await prisma.conversationParticipant.findFirst({
        where: {
          conversationId,
          userId,
          conversation: { directKey: { not: LEGACY_CONVERSATION_KEY } },
        },
        select: { conversationId: true },
      });

      if (!membership) {
        sendError(
          socket,
          "FORBIDDEN",
          "You do not belong to this conversation.",
          clientMessageId,
        );
        return;
      }

      if (parsed.type === "join_conversation") {
        subscriptions.add(conversationId);
        const messages = await prisma.message.findMany({
          where: { conversationId },
          take: 50,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          include: {
            sender: {
              select: { id: true, name: true },
            },
          },
        });

        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "history",
              conversationId,
              messages: messages.reverse().map((message) => ({
                id: message.id,
                content: message.content,
                timestamp: message.createdAt.toISOString(),
                sender: message.sender,
              })),
            }),
          );
        }
        return;
      }

      if (!("content" in parsed) || typeof parsed.content !== "string") {
        sendError(
          socket,
          "INVALID_MESSAGE",
          "Message content is required.",
          clientMessageId,
        );
        return;
      }

      const content = parsed.content.trim();
      if (!content) {
        sendError(
          socket,
          "EMPTY_MESSAGE",
          "Message cannot be empty.",
          clientMessageId,
        );
        return;
      }
      if (content.length > 2000) {
        sendError(
          socket,
          "MESSAGE_TOO_LONG",
          "Message cannot exceed 2000 characters.",
          clientMessageId,
        );
        return;
      }
      if (!subscriptions.has(conversationId)) {
        sendError(
          socket,
          "CONVERSATION_NOT_JOINED",
          "Join this conversation before sending.",
          clientMessageId,
        );
        return;
      }

      // Re-check membership immediately before persistence.
      const currentMembership = await prisma.conversationParticipant.findFirst({
        where: {
          conversationId,
          userId,
          conversation: { directKey: { not: LEGACY_CONVERSATION_KEY } },
        },
        select: { conversationId: true },
      });
      if (!currentMembership) {
        subscriptions.delete(conversationId);
        sendError(
          socket,
          "FORBIDDEN",
          "You do not belong to this conversation.",
          clientMessageId,
        );
        return;
      }

      const savedMessage = await prisma.$transaction(async (transaction) => {
        const message = await transaction.message.create({
          data: { content, senderId: userId, conversationId },
          include: {
            sender: {
              select: { id: true, name: true },
            },
          },
        });
        await transaction.conversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });
        return message;
      });

      const payload = JSON.stringify({
        type: "message",
        conversationId,
        id: savedMessage.id,
        content: savedMessage.content,
        timestamp: savedMessage.createdAt.toISOString(),
        sender: savedMessage.sender,
      });

      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: "message_sent",
              conversationId,
              clientMessageId,
              messageId: savedMessage.id,
              message: {
                id: savedMessage.id,
                content: savedMessage.content,
                timestamp: savedMessage.createdAt.toISOString(),
                sender: savedMessage.sender,
              },
            }),
          );
        }
      } catch (acknowledgementError: unknown) {
        console.error(
          "Message acknowledgement failed after persistence:",
          acknowledgementError,
        );
      }

      let broadcastAttempts = 0;
      let broadcastFailures = 0;
      for (const client of wss.clients) {
        if (
          client.readyState === WebSocket.OPEN &&
          subscribedConversations.get(client)?.has(conversationId)
        ) {
          broadcastAttempts += 1;
          try {
            client.send(payload);
          } catch (broadcastError: unknown) {
            broadcastFailures += 1;
            console.error(
              "Private message broadcast failed for one recipient after persistence:",
              broadcastError,
            );
          }
        }
      }

      console.log(
        `Private message persisted; broadcast attempted for ${broadcastAttempts} recipient(s), ` +
          `${broadcastFailures} failed.`,
      );
    } catch (error: unknown) {
      console.error("Message processing failed:", error);

      if (socket.readyState === WebSocket.OPEN) {
        sendError(
          socket,
          "MESSAGE_UNAVAILABLE",
          "Unable to send message. Please try again.",
          clientMessageId,
        );
      }
    }
  });

  socket.on("close", () => {
    subscriptions.clear();
    console.log("Authenticated client disconnected");
  });

  socket.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

server.listen(PORT, () => {
  console.log(`ChatSpace WebSocket server running on port ${PORT}`);
});

server.on("error", (error) => {
  console.error("HTTP server error:", error.message);
});
