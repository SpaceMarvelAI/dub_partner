import { prismaEdge } from "@/lib/prisma/edge";
import { UserProps } from "@/lib/types";

export async function getDefaultWorkspace(user: UserProps) {
  let defaultWorkspace = user?.defaultWorkspace;

  if (!defaultWorkspace) {
    // prismaEdge needs a real PlanetScale-compatible HTTP endpoint
    // (PLANETSCALE_DATABASE_URL); without one, degrade the same as
    // "user not found" instead of crashing every request here.
    try {
      const refreshedUser = await prismaEdge.user.findUnique({
        where: {
          id: user.id,
        },
        select: {
          defaultWorkspace: true,
          projects: {
            select: {
              project: {
                select: {
                  slug: true,
                },
              },
            },
            take: 1,
          },
        },
      });

      defaultWorkspace =
        refreshedUser?.defaultWorkspace ||
        refreshedUser?.projects[0]?.project?.slug ||
        undefined;
    } catch (error) {
      console.error("Failed to look up default workspace", error);
    }
  }

  return defaultWorkspace;
}
