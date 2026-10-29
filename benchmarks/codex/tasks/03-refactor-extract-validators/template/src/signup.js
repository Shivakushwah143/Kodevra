/**
 * Signup validation. Both field rules live inline here today; the refactor
 * moves them into src/validators.js without changing a single message.
 */
export function validateSignup(input) {
  const email = typeof input?.email === "string" ? input.email.trim() : "";
  const password = typeof input?.password === "string" ? input.password : "";

  const errors = [];

  if (!email) {
    errors.push("Email is required");
  } else {
    const at = email.indexOf("@");
    if (at === -1 || at === email.length - 1) errors.push("Email is invalid");
  }

  if (!password) {
    errors.push("Password is required");
  } else if (password.length < 8) {
    errors.push("Password must be at least 8 characters");
  }

  return errors;
}
