import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { prisma } from "@chatspace/db";
import { authOptions } from "@/lib/auth";

const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 20;

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  if (!query || query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ users: [] });
  }

  const users = await prisma.user.findMany({
    where: {
      id: { not: userId },
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: MAX_RESULTS,
  });

  return NextResponse.json({ users });
}
