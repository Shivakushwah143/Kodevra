const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value) {
  return Boolean(value) && EMAIL.test(value);
}
