import { escapeHtml } from "./escape.js";

export function renderComment({ author, body }) {
  return `<article><h3>${author}</h3><p>${body}</p></article>`;
}

export { escapeHtml };
