import assert from "node:assert/strict";
import http from "node:http";

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForCondition(
	predicate,
	message,
	timeoutMs = 240_000,
) {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		assert.ok(Date.now() < deadline, message);
		await delay(10);
	}
}

export function startLlmOverlapServer() {
	const events = [];
	const activeCounts = new Map();
	const pendingResponses = new Set();
	let released = false;
	let overlapDetected = false;
	let maximumActiveExecutions = 0;

	const server = http.createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			let payload;
			try {
				payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch (error) {
				response.writeHead(400).end(String(error));
				return;
			}
			const token = payload.executionToken;
			assert.equal(typeof token, "string");
			activeCounts.set(token, (activeCounts.get(token) ?? 0) + 1);
			maximumActiveExecutions = Math.max(
				maximumActiveExecutions,
				activeCounts.size,
			);
			if (activeCounts.size > 1) overlapDetected = true;
			events.push({ type: "request_opened", token, payload });
			let closed = false;
			const recordClose = () => {
				if (closed) return;
				closed = true;
				pendingResponses.delete(response);
				const remaining = (activeCounts.get(token) ?? 1) - 1;
				if (remaining <= 0) activeCounts.delete(token);
				else activeCounts.set(token, remaining);
				events.push({ type: "request_closed", token });
			};
			response.once("close", recordClose);
			response.once("finish", recordClose);
			if (released) response.writeHead(200).end("ok");
			else pendingResponses.add(response);
		});
	});

	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("test LLM server did not bind a TCP address"));
				return;
			}
			resolve({
				url: `http://127.0.0.1:${address.port}/completion`,
				events,
				activeExecutionCount: () => activeCounts.size,
				maximumActiveExecutions: () => maximumActiveExecutions,
				overlapDetected: () => overlapDetected,
				release() {
					released = true;
					for (const response of [...pendingResponses]) {
						response.writeHead(200).end("ok");
					}
				},
				async close() {
					released = true;
					for (const response of [...pendingResponses]) response.destroy();
					server.closeAllConnections();
					await new Promise((closeResolve) => server.close(closeResolve));
				},
			});
		});
	});
}
