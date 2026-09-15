import { prisma } from "@/lib/prisma";
import { cache } from "react";

export const getProgramSlugs = cache(async () => {
  try {
    return await prisma.program.findMany({
      select: {
        slug: true,
      },
      orderBy: {
        applications: {
          _count: "desc",
        },
      },
      take: 250,
    });
  } catch {
    // Used by generateStaticParams — if the DB isn't reachable at build time
    // (e.g. building a Docker image with no DATABASE_URL configured), fall
    // back to no pre-rendered params instead of failing the whole build.
    // Pages still render fine on-demand at request time.
    return [];
  }
});
