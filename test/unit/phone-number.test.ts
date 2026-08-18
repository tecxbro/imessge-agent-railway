import { describe, expect, it } from "vitest";

import {
  normalizeDashboardOwnerPhoneNumber,
  OwnerPhoneNumberValidationError,
} from "../../src/runtime/phone-number.js";

describe("dashboard owner phone normalization", () => {
  it.each([
    ["4155550123", "US", "+14155550123"],
    ["(415) 555-0123", "US", "+14155550123"],
    ["1 415 555 0123", "US", "+14155550123"],
    ["+1 415 555 0123", "US", "+14155550123"],
    ["020 7183 8750", "GB", "+442071838750"],
    ["+44 20 7183 8750", "GB", "+442071838750"],
  ])("normalizes %s for %s", (phoneNumber, countryCode, expected) => {
    expect(
      normalizeDashboardOwnerPhoneNumber({ countryCode, phoneNumber }),
    ).toBe(expected);
  });

  it.each([
    ["not-a-phone", "US"],
    ["+33 1 42 68 53 00", "GB"],
    ["4155550123", "ZZ"],
    ["4155550123", ""],
    ["1".repeat(65), "US"],
  ])("rejects %s for %s", (phoneNumber, countryCode) => {
    expect(() =>
      normalizeDashboardOwnerPhoneNumber({ countryCode, phoneNumber }),
    ).toThrow(OwnerPhoneNumberValidationError);
  });
});
