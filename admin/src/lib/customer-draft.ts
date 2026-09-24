// Retain exact normalized arguments in memory after an uncertain create. Never persist PII.
export function customerCreateArguments(fields: {
  email: string;
  full_name: string;
  phone: string;
}): Readonly<{ email?: string; full_name?: string; phone?: string }> {
  return Object.freeze({
    ...(fields.full_name ? { full_name: fields.full_name } : {}),
    ...(fields.email.trim() ? { email: fields.email.trim() } : {}),
    ...(fields.phone.trim() ? { phone: fields.phone.trim() } : {}),
  });
}
