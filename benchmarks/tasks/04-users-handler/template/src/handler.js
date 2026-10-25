export function createUsersHandler(users) {
  return (req, res) => {
    res.statusCode = 501;
    res.setHeader("content-type", "text/plain");
    res.end(`not implemented for ${users.length} users`);
  };
}
