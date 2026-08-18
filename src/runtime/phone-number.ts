import {
  isSupportedCountry,
  parsePhoneNumberWithError,
  type CountryCode,
} from "libphonenumber-js/max";
import { z } from "zod";

const MAX_DASHBOARD_PHONE_INPUT_LENGTH = 64;

export const ownerPhoneNumberSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/u);

export class OwnerPhoneNumberValidationError extends Error {
  public readonly code = "OWNER_PHONE_NUMBER_INVALID" as const;

  public constructor() {
    super("OWNER_PHONE_NUMBER_INVALID");
    this.name = "OwnerPhoneNumberValidationError";
  }
}

export function normalizeDashboardOwnerPhoneNumber(input: {
  phoneNumber: string;
  countryCode: string;
}): string {
  const phoneNumber = input.phoneNumber.trim();
  const countryCode = input.countryCode.trim().toUpperCase();
  if (
    phoneNumber.length === 0 ||
    input.phoneNumber.length > MAX_DASHBOARD_PHONE_INPUT_LENGTH ||
    countryCode.length !== 2 ||
    !isSupportedCountry(countryCode)
  ) {
    throw new OwnerPhoneNumberValidationError();
  }

  try {
    const parsed = parsePhoneNumberWithError(phoneNumber, {
      defaultCountry: countryCode as CountryCode,
      extract: false,
    });
    if (!parsed.isValid() || parsed.country !== countryCode) {
      throw new OwnerPhoneNumberValidationError();
    }
    return ownerPhoneNumberSchema.parse(parsed.number);
  } catch (error) {
    if (error instanceof OwnerPhoneNumberValidationError) {
      throw error;
    }
    throw new OwnerPhoneNumberValidationError();
  }
}
