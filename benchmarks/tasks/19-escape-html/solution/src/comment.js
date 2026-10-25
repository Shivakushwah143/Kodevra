import { escapeHtml } from "./escape.js";

export function renderComment({ author, body }) {
  return `<article><h3>${escapeHtml(author)}</h3><p>${escapeHtml(body)}</p></article>`;
}

export { escapeHtml };
