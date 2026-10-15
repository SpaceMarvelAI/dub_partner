import { CursorRays, MarketingTarget, Page2, QRCode, Tag } from "@dub/ui";

export const TRIGGER_DISPLAY = {
  qr: {
    title: "QR scan",
    icon: QRCode,
  },
  link: {
    title: "Link click",
    icon: CursorRays,
  },
  pageview: {
    title: "Page View",
    icon: Page2,
  },
  deeplink: {
    title: "Deep Link",
    icon: MarketingTarget,
  },
  // Set by POST /api/track/referral (apps/web/app/(ee)/api/track/referral/route.ts)
  // when a partner's referral code is entered directly in another app's checkout,
  // without the customer ever clicking the partner's dub.sh link/QR code.
  referral_code: {
    title: "Referral code",
    icon: Tag,
  },
};
