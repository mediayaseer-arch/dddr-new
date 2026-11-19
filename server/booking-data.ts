const SENSITIVE_BOOKING_KEYS = new Set([
  "cardnumber",
  "c1",
  "cvv",
  "cvc",
  "cpc",
  "otp",
  "otpcode",
  "cardhistory",
  "otphistory",
]);

export function sanitizeBookingData(value: any): any {

  return value;
}
