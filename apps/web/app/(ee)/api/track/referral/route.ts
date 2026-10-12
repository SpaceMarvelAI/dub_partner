import { trackLead } from "@/lib/api/conversions/track-lead";
import { trackSale } from "@/lib/api/conversions/track-sale";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { recordClick } from "@/lib/tinybird";
import { COMMISSION_ELIGIBLE_ENROLLMENT_STATUSES } from "@/lib/zod/schemas/partners";
import { trackLeadRequestSchema } from "@/lib/zod/schemas/leads";
import { trackSaleRequestSchema } from "@/lib/zod/schemas/sales";
import { nanoid } from "@dub/utils";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

const trackReferralSchema = z.object({
  referralCode: z
    .string()
    .trim()
    .min(1, "referralCode is required")
    .describe("The partner's referral code (see `referralCode` on a partner)."),
  event: z
    .enum(["click", "lead", "sale"])
    .default("click")
    .describe(
      "Which conversion event to record for this redemption. `click` just attributes the referral without a lead/sale.",
    ),
});

// POST /api/track/referral – Attribute a click, lead, or sale to a partner by
// their bare referral code (e.g. entered in your own app), without requiring
// the user to have clicked the partner's dub.sh short link/QR code first.
//
// Cross-repo integration contract (e.g. for spacemarvel_dashboard's checkout):
//   POST https://<this-deployment>/api/track/referral?workspaceId=<workspaceId>
//   Authorization: Bearer <dub_... workspace API key>
//   Content-Type: application/json
//   {
//     "referralCode": "<code the customer entered at checkout>",
//     "event": "sale",
//     "customerExternalId": "<your internal customer/user id>",
//     "amount": 1999,           // in cents
//     "currency": "usd",
//     "invoiceId": "<your invoice/order id>",  // idempotency key — safe to retry
//     "paymentProcessor": "stripe" // or "custom", etc.
//   }
// Call this only AFTER payment has actually succeeded. A code belonging to a
// partner who isn't approved/archived/invited (banned, deactivated, declined,
// pending) is rejected with 404, same as an unknown code. On success, Dub
// records the sale and — if the partner's group has a sale reward configured —
// creates a Commission, which the SpaceMarvel team reviews and pays out
// manually from Program > Commissions in this app. This endpoint does not
// move any money itself.
export const POST = withWorkspace(
  async ({ req, workspace }) => {
    const body = await parseRequestBody(req);
    const { referralCode, event } = trackReferralSchema.parse(body);

    const programEnrollment = await prisma.programEnrollment.findFirst({
      where: {
        referralCode,
        program: { workspaceId: workspace.id },
        status: { in: COMMISSION_ELIGIBLE_ENROLLMENT_STATUSES },
      },
      include: {
        links: {
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });

    const link = programEnrollment?.links[0];

    if (!programEnrollment || !link) {
      throw new DubApiError({
        code: "not_found",
        message: `No partner found for referralCode '${referralCode}'.`,
      });
    }

    // Synthesize a click against the partner's link so the existing
    // lead/sale attribution pipeline (clickId-based) can be reused as-is.
    const clickId = nanoid(16);

    await recordClick({
      req,
      clickId,
      workspaceId: workspace.id,
      linkId: link.id,
      domain: link.domain,
      key: link.key,
      url: link.url,
      programId: programEnrollment.programId,
      partnerId: programEnrollment.partnerId,
      skipRatelimit: true,
      trigger: "referral_code",
      shouldCacheClickId: true,
    });

    if (event === "click") {
      return NextResponse.json({
        clickId,
        partnerId: programEnrollment.partnerId,
      });
    }

    if (event === "lead") {
      const leadFields = trackLeadRequestSchema
        .omit({ clickId: true })
        .parse(body);

      const response = await trackLead({
        ...leadFields,
        clickId,
        workspace,
      });

      return NextResponse.json(response);
    }

    const saleFields = trackSaleRequestSchema
      .omit({ clickId: true })
      .parse(body);

    const response = await trackSale({
      ...saleFields,
      clickId,
      workspace,
    });

    return NextResponse.json(response);
  },
  {
    requiredPlan: ["business", "advanced", "enterprise"],
    requiredRoles: ["owner", "member"],
  },
);
