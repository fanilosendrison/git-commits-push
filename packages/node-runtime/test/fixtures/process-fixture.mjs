import { spawn } from "node:child_process";

const mode = process.argv[2];

switch (mode) {
	case "echo-args":
		process.stdout.write(JSON.stringify(process.argv.slice(3)));
		break;
	case "context":
		process.stdout.write(
			JSON.stringify({
				cwd: process.cwd(),
				value: process.env.NODE_RUNTIME_TEST_VALUE ?? null,
			}),
		);
		break;
	case "stdin": {
		const chunks = [];
		for await (const chunk of process.stdin) chunks.push(chunk);
		process.stdout.write(Buffer.concat(chunks));
		break;
	}
	case "stdin-size": {
		let byteLength = 0;
		for await (const chunk of process.stdin) byteLength += chunk.byteLength;
		process.stdout.write(String(byteLength));
		break;
	}
	case "split-output":
		process.stdout.write("captured stdout");
		process.stderr.write("captured stderr");
		break;
	case "exit":
		process.exitCode = Number(process.argv[3]);
		break;
	case "emit-pid-and-exit":
		process.stdout.write(`${process.pid}\n`);
		break;
	case "signal":
		process.kill(process.pid, "SIGTERM");
		break;
	case "wait":
		setInterval(() => {}, 1_000);
		break;
	case "ignore-sigterm":
		process.on("SIGTERM", () => {});
		process.stdout.write("ready\n");
		setInterval(() => {}, 1_000);
		break;
	case "spawn-descendant": {
		const descendant = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{
				stdio: "ignore",
			},
		);
		process.stdout.write(`${descendant.pid}\n`);
		setInterval(() => {}, 1_000);
		break;
	}
	case "emit": {
		const byteLength = Number(process.argv[3]);
		process.stdout.write("x".repeat(byteLength));
		break;
	}
	case "emit-chunks": {
		const chunkCount = Number(process.argv[3]);
		for (let index = 0; index < chunkCount; index += 1) {
			process.stdout.write(`${index}\n`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		break;
	}
	default:
		process.stderr.write(`Unknown fixture mode: ${mode ?? "<missing>"}\n`);
		process.exitCode = 64;
}
