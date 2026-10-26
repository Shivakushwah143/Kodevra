import { validateEmail, validatePassword } from "./validators.js";

/** Field order is part of the API: email first, then password. */
export function validateSignup(input) {
  return [validateEmail(input?.email), validatePassword(input?.password)].filter((message) => message !== null);
}
