const MAX_PAGE_SIZE = 100;

function wholeNumber(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function paginate(items, { page = 1, pageSize = 10 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const safePage = Math.max(1, wholeNumber(page, 1));
  const safeSize = Math.min(MAX_PAGE_SIZE, Math.max(1, wholeNumber(pageSize, 10)));
  const total = list.length;
  const totalPages = Math.ceil(total / safeSize);
  const start = (safePage - 1) * safeSize;

  return {
    items: list.slice(start, start + safeSize),
    page: safePage,
    pageSize: safeSize,
    total,
    totalPages,
    hasNext: safePage < totalPages,
    hasPrev: total > 0 && safePage > 1,
  };
}
