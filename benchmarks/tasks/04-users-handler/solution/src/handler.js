export function createUsersHandler(users) {
  return (req, res) => {
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(body));
    };

    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname !== "/users") {
      send(404, { error: "not found" });
      return;
    }
    if (req.method !== "GET") {
      send(405, { error: "method not allowed" });
      return;
    }
    send(200, users);
  };
}
