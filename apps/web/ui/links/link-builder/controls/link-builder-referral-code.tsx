import { LinkFormData } from "@/ui/links/link-builder/link-builder-provider";
import { CopyButton, InfoTooltip } from "@dub/ui";
import { memo } from "react";
import { useFormContext, useWatch } from "react-hook-form";

/**
 * A bare reference code derived from the short link's key (e.g. "abc123" ->
 * "ABC123"). Purely a display/reference value — not used for attribution.
 */
export const LinkBuilderReferralCode = memo(() => {
  const { control } = useFormContext<LinkFormData>();
  const [key] = useWatch({ control, name: ["key"] });

  const referralCode = key ? key.toUpperCase() : "";

  return (
    <div>
      <div className="flex items-center gap-2">
        <label className="block text-sm font-medium text-neutral-700">
          Referral Code
        </label>
        <InfoTooltip content="A bare code derived from the short link, which you can hand out as a reference." />
      </div>
      <div className="mt-2 flex items-center justify-between rounded-md border border-neutral-300 px-3 py-2">
        {referralCode ? (
          <>
            <span className="truncate font-mono text-sm text-neutral-900">
              {referralCode}
            </span>
            <CopyButton
              value={referralCode}
              variant="neutral"
              successMessage="Copied referral code to clipboard!"
            />
          </>
        ) : (
          <span className="text-sm text-neutral-400">
            Enter a short link to generate a referral code
          </span>
        )}
      </div>
    </div>
  );
});

LinkBuilderReferralCode.displayName = "LinkBuilderReferralCode";
