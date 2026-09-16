import { prismaEdge } from "@/lib/prisma/edge";
import { UserProps } from "@/lib/types";
import { NextRequest } from "next/server";

export async function hasPendingInvites({
  req,
  user,
}: {
  req: NextRequest;
  user: UserProps;
}) {
  if (
    req.nextUrl.searchParams.get("invite") ||
    req.nextUrl.pathname.startsWith("/invites/")
  ) {
    return true;
  }

  // prismaEdge needs a real PlanetScale-compatible HTTP endpoint
  // (PLANETSCALE_DATABASE_URL); without one, degrade to "no pending
  // invites" instead of crashing every request through this middleware.
  let pendingInvites: number;
  try {
    pendingInvites = await prismaEdge.projectInvite.count({
      where: {
        email: user.email,
        expires: {
          gte: new Date(),
        },
      },
    });
  } catch (error) {
    console.error("Failed to check pending invites", error);
    return false;
  }

  return pendingInvites > 0;
}
