require("node:http").createServer((req, res) => { res.writeHead(500); res.end("internal error"); }).listen(Number(process.env.PORT), "127.0.0.1");
