/** Reusable field validators. Each returns an error message string or null. */

export function validateEmail(value) {
  const email = typeof value === "string" ? value.trim() : "";
  if (!email) return "Email is required";
  const at = email.indexOf("@");
  if (at === -1 || at === email.length - 1) return "Email is invalid";
  return null;
}

export function validatePassword(value) {
  const password = typeof value === "string" ? value : "";
  if (!password) return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters";
  return null;
}
