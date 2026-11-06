import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { prisma, Prisma } from "@chatspace/db";
import { authOptions } from "@/lib/auth";

const LEGACY_CONVERSATION_KEY = "legacy-shared-room";
const MAX_CONVERSATIONS = 100;

type ConversationSummary = {
  id: string;
  participant: {
    id: string;
    name: string;
    email: string;
  };
  latestMessage: {
    id: string;
    content: string;
    timestamp: string;
    senderId: string;
  } | null;
};

function directKey(firstUserId: string, secondUserId: string) {
  return [firstUserId, secondUserId].sort().join(":");
}

function toSummary(
  conversation: {
    id: string;
    participants: Array<{
      user: { id: string; name: string; email: string };
    }>;
    messages: Array<{
      id: string;
      content: string;
      createdAt: Date;
      senderId: string;
    }>;
  },
  userId: string,
): ConversationSummary | null {
  const participant = conversation.participants.find(
    ({ user }) => user.id !== userId,
  )?.user;

  if (!participant) return null;

  const latestMessage = conversation.messages[0];
  return {
    id: conversation.id,
    participant,
    latestMessage: latestMessage
      ? {
          id: latestMessage.id,
          content: latestMessage.content,
          timestamp: latestMessage.createdAt.toISOString(),
          senderId: latestMessage.senderId,
        }
      : null,
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const conversations = await prisma.conversation.findMany({
    where: {
      directKey: { not: LEGACY_CONVERSATION_KEY },
      participants: { some: { userId } },
    },
    select: {
      id: true,
      updatedAt: true,
      participants: {
        select: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      },
      messages: {
        select: {
          id: true,
          content: true,
          createdAt: true,
          senderId: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: MAX_CONVERSATIONS,
  });

  const summaries = conversations
    .map((conversation) => toSummary(conversation, userId))
    .filter(
      (conversation): conversation is ConversationSummary =>
        conversation !== null,
    )
    .sort((first, second) => {
      const firstTime = first.latestMessage?.timestamp ?? "";
      const secondTime = second.latestMessage?.timestamp ?? "";
      return (
        secondTime.localeCompare(firstTime) || first.id.localeCompare(second.id)
      );
    });

  return NextResponse.json({ conversations: summaries });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  const body: unknown = await request.json().catch(() => null);
  if (
    typeof body !== "object" ||
    body === null ||
    !("userId" in body) ||
    typeof body.userId !== "string" ||
    !body.userId.trim() ||
    body.userId.length > 100
  ) {
    return NextResponse.json(
      { error: "A valid userId is required." },
      { status: 400 },
    );
  }

  const otherUserId = body.userId.trim();
  if (otherUserId === userId) {
    return NextResponse.json(
      { error: "You cannot start a conversation with yourself." },
      { status: 400 },
    );
  }

  const otherUser = await prisma.user.findUnique({
    where: { id: otherUserId },
    select: { id: true, name: true, email: true },
  });

  if (!otherUser) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  const key = directKey(userId, otherUserId);
  const existing = await prisma.conversation.findUnique({
    where: { directKey: key },
  });

  if (existing) {
    return NextResponse.json({
      conversation: { id: existing.id, participant: otherUser },
    });
  }

  try {
    const conversation = await prisma.conversation.create({
      data: {
        directKey: key,
        participants: {
          create: [{ userId }, { userId: otherUserId }],
        },
      },
      select: { id: true },
    });

    return NextResponse.json(
      { conversation: { id: conversation.id, participant: otherUser } },
      { status: 201 },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const concurrentConversation = await prisma.conversation.findUnique({
        where: { directKey: key },
      });

      if (concurrentConversation) {
        return NextResponse.json({
          conversation: {
            id: concurrentConversation.id,
            participant: otherUser,
          },
        });
      }
    }

    console.error("Conversation creation failed:", error);
    return NextResponse.json(
      { error: "Unable to start conversation." },
      { status: 500 },
    );
  }
}
