// Aadhaar masking before any OCR text leaves the phone (rule 7; UIDAI: a full Aadhaar number must not be
// stored, only the last 4 digits may be shown). The database applies the same rule again
// (private.mask_aadhaar in 20261119600000_device_ocr.sql); keep the two in step.
//
// Rule: 12 digits whose first digit is 2-9 (Aadhaar numbers never start with 0 or 1), written plain or
// grouped 4-4-4 with spaces / hyphens (at most two between groups), not part of a longer digit run,
// become "XXXX XXXX 1234". No checksum test on purpose: an OCR misread would fail the Verhoeff check
// and leak 11 correct digits. Other numbers (registration, DL, policy, chassis) are report fields and
// stay as read; a 12-digit policy-number segment is masked too (privacy first, the photo still shows it).

const AADHAAR = /(^|[^0-9])[2-9][0-9]{3}[ -]{0,2}[0-9]{4}[ -]{0,2}([0-9]{4})(?![0-9])/g;

export const MASKED_PREFIX = 'XXXX XXXX ';

export function maskAadhaar(text: string): string {
  return text.replace(AADHAAR, (_m, before: string, last4: string) => `${before}${MASKED_PREFIX}${last4}`);
}
