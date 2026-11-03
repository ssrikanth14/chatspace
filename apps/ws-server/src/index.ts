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

const server = createServer((req, res) => {
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024,
});

function sendError(socket: WebSocket, code: string, message: string) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "error", code, message }));
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

// Store the verified user ID for each WebSocket connection.
const authenticatedUsers = new WeakMap<WebSocket, string>();

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

  console.log("Authenticated client connected");
  // Load the latest 50 messages for the authenticated user.
  void prisma.message
    .findMany({
      take: 50,
      orderBy: {
        createdAt: "desc",
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    })
    .then((messages) => {
      if (socket.readyState !== WebSocket.OPEN) return;

      socket.send(
        JSON.stringify({
          type: "history",
          messages: messages.reverse().map((message) => ({
            id: message.id,
            content: message.content,
            timestamp: message.createdAt.toISOString(),
            sender: message.sender,
          })),
        }),
      );
    })
    .catch((error: unknown) => {
      console.error("Failed to load chat history:", error);
      sendError(
        socket,
        "HISTORY_UNAVAILABLE",
        "Chat history is temporarily unavailable.",
      );
    });

  socket.on("message", async (data, isBinary) => {
    try {
      if (isBinary) {
        sendError(socket, "INVALID_PAYLOAD", "Message payload must be text.");
        return;
      }

      const content = data.toString().trim();

      // Validate message content.
      if (!content) {
        sendError(socket, "EMPTY_MESSAGE", "Message cannot be empty.");
        return;
      }

      if (content.length > 2000) {
        sendError(
          socket,
          "MESSAGE_TOO_LONG",
          "Message cannot exceed 2000 characters.",
        );
        return;
      }

      // Save the message in PostgreSQL.
      const savedMessage = await prisma.message.create({
        data: {
          content,
          senderId: userId,
        },
        include: {
          sender: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      // Broadcast only after successful database persistence.
      const payload = JSON.stringify({
        type: "message",
        id: savedMessage.id,
        content: savedMessage.content,
        timestamp: savedMessage.createdAt.toISOString(),
        sender: savedMessage.sender,
      });

      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }

      console.log("Message saved and broadcast successfully.");
    } catch (error) {
      console.error("Message processing failed:", error);

      if (socket.readyState === WebSocket.OPEN) {
        sendError(
          socket,
          "MESSAGE_UNAVAILABLE",
          "Unable to send message. Please try again.",
        );
      }
    }
  });

  socket.on("close", () => {
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
