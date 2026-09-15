import { prisma } from "@/lib/prisma";
import { Category } from "@prisma/client";

export const revalidate = 3600;

export async function generateStaticParams() {
  let programs: { slug: string }[];
  try {
    programs = await prisma.program.findMany({
      where: {
        addedToMarketplaceAt: {
          not: null,
        },
      },
      select: {
        slug: true,
      },
    });
  } catch {
    // If the DB isn't reachable at build time (e.g. building a Docker image
    // with no DATABASE_URL configured), skip static pre-rendering entirely —
    // the root/all/category pages below also render live program data, so
    // they can't be pre-rendered without the DB either. All segments render
    // on-demand at request time instead.
    return [];
  }

  const categoryPages = Object.values(Category).map((category) => ({
    segments: ["c", category.toLowerCase()],
  }));

  const programPages = programs.map((program) => ({
    segments: [program.slug],
  }));

  return [
    { segments: [] },
    { segments: ["all"] },
    ...categoryPages,
    ...programPages,
  ];
}
