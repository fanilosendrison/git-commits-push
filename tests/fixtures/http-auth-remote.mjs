import http from "node:http";

const server = http.createServer((_request, response) => {
	response.writeHead(401, {
		"Content-Type": "text/plain",
		"WWW-Authenticate": 'Basic realm="git-test"',
	});
	response.end("authentication required\n");
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("HTTP fixture did not receive a TCP port");
	}
	process.stdout.write(`${address.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
	});
}
