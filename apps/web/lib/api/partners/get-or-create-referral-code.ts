import { prisma } from "@/lib/prisma";
import { nanoid } from "@dub/utils";
import { Prisma, ProgramEnrollment } from "@prisma/client";
import slugify from "@sindresorhus/slugify";

function deriveReferralCode({
  username,
  name,
  email,
}: {
  username?: string | null;
  name?: string | null;
  email: string | null;
}) {
  const base = username || name || email?.split("@")[0] || "PARTNER";
  const slug = slugify(base, { separator: "" }).toUpperCase().slice(0, 20);
  return slug || "PARTNER";
}

// Lazily generates and persists a referral code for a program enrollment.
// Safe to call repeatedly — once an enrollment has a code, it's never changed.
// This is what SpaceMarvel's own system should accept directly (independent
// of the partner's dub.sh short link / QR code) to attribute a referral.
export async function getOrCreateReferralCode({
  programEnrollment,
  partner,
}: {
  programEnrollment: Pick<ProgramEnrollment, "id" | "referralCode">;
  partner: {
    username?: string | null;
    name?: string | null;
    email: string | null;
  };
}): Promise<string> {
  if (programEnrollment.referralCode) {
    return programEnrollment.referralCode;
  }

  let code = deriveReferralCode(partner);

  while (true) {
    try {
      const updated = await prisma.programEnrollment.update({
        where: { id: programEnrollment.id },
        data: { referralCode: code },
        select: { referralCode: true },
      });

      return updated.referralCode!;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // referralCode already taken within this program — append a short suffix and retry
        code = `${code}${nanoid(4).toUpperCase()}`;
        continue;
      }

      throw error;
    }
  }
}
