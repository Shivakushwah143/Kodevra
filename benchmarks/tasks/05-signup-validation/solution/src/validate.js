export function validateSignup({ email, password } = {}) {
  const mail = typeof email === "string" ? email : "";
  const secret = typeof password === "string" ? password : "";

  const at = mail.indexOf("@");
  const emailOk =
    at > 0 &&
    mail.indexOf("@", at + 1) === -1 &&
    mail.indexOf(".", at + 1) > at + 1;
  const passwordOk = secret.length >= 8 && /\d/.test(secret);

  const errors = [];
  if (!emailOk) errors.push("email");
  if (!passwordOk) errors.push("password");
  return { ok: errors.length === 0, errors };
}
