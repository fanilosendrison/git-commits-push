import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync } from "node:fs";

const [mode, ...arguments_] = process.argv.slice(2);

async function writeWithBackpressure(chunk) {
	if (!process.stdout.write(chunk)) {
		await once(process.stdout, "drain");
	}
}

async function readInput(delayMs = 0) {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return Buffer.concat(chunks);
}

function waitForSignal(role) {
	const signalLog = process.env.PIPELINE_SIGNAL_LOG;
	if (!signalLog) throw new Error("PIPELINE_SIGNAL_LOG is required");
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => {
			appendFileSync(signalLog, `${role}:${signal}\n`);
			process.exit(0);
		});
	}
	appendFileSync(signalLog, `${role}:ready\n`);
	setInterval(() => {}, 1000);
}

switch (mode) {
	case "argument-producer": {
		process.stderr.write("producer-stderr\n");
		await writeWithBackpressure(arguments_[0] ?? "");
		break;
	}
	case "prefix-consumer": {
		process.stderr.write("consumer-stderr\n");
		const input = await readInput();
		await writeWithBackpressure(`bridge:${input.toString("utf8")}`);
		break;
	}
	case "byte-producer": {
		const byteCount = Number.parseInt(arguments_[0] ?? "0", 10);
		const chunk = Buffer.alloc(64 * 1024, "x");
		let written = 0;
		while (written < byteCount) {
			const nextChunk = chunk.subarray(
				0,
				Math.min(chunk.length, byteCount - written),
			);
			await writeWithBackpressure(nextChunk);
			written += nextChunk.length;
		}
		break;
	}
	case "digest-consumer": {
		const input = await readInput(Number.parseInt(arguments_[0] ?? "0", 10));
		await writeWithBackpressure(
			JSON.stringify({
				byteCount: input.length,
				sha256: createHash("sha256").update(input).digest("hex"),
			}),
		);
		break;
	}
	case "exit-producer": {
		process.exitCode = Number.parseInt(arguments_[0] ?? "1", 10);
		break;
	}
	case "exit-consumer": {
		await readInput();
		process.exitCode = Number.parseInt(arguments_[0] ?? "1", 10);
		break;
	}
	case "signal-producer": {
		waitForSignal("producer");
		break;
	}
	case "signal-consumer": {
		waitForSignal("consumer");
		break;
	}
	default:
		throw new Error(`Unknown pipeline fixture mode: ${String(mode)}`);
}
