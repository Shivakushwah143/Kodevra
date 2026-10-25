export function validateForm(input) {
  const errors = {};
  if (!input.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    errors.email = "invalid email";
  }
  if (!input.name || input.name.trim().length < 2) {
    errors.name = "name is too short";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}
