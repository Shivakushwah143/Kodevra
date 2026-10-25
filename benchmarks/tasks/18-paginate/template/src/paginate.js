export function paginate(items, { page = 1, pageSize = 10 } = {}) {
  const start = (page - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total: items.length,
    totalPages: Math.floor(items.length / pageSize),
    hasNext: false,
    hasPrev: false,
  };
}
