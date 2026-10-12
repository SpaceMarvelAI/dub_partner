/**
 * Generates referral codes for existing partner enrollments that already have
 * at least one link but were enrolled before referral codes existed.
 *
 *   cd apps/web
 *   pnpm run script partners/backfill-referral-codes
 */

import { getOrCreateReferralCode } from "@/lib/api/partners/get-or-create-referral-code";
import { prisma } from "@/lib/prisma";
import "dotenv-flow/config";

async function main() {
  const enrollments = await prisma.programEnrollment.findMany({
    where: {
      referralCode: null,
      links: { some: {} },
    },
    include: { partner: true },
  });

  console.log(
    `Found ${enrollments.length} enrollment(s) with a link but no referral code.`,
  );

  for (const enrollment of enrollments) {
    const referralCode = await getOrCreateReferralCode({
      programEnrollment: enrollment,
      partner: enrollment.partner,
    });

    console.log(
      `${enrollment.partner.email} (${enrollment.id}) -> ${referralCode}`,
    );
  }
}

main()
  .catch((error) => {
    console.error("Referral code backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
