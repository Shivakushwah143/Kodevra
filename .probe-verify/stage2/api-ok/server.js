const http = require("node:http");
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: "probe" })); return; }
  res.writeHead(404); res.end("nope");
}).listen(port, "127.0.0.1");
