import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * GitRepoFixture — NIB-T §2
 * Creates an isolated, real git repository under a system temp directory.
 * Each instance owns its own directory and must be cleaned up via `dispose()`.
 */
export class GitRepoFixture {
	readonly dir: string;

	private constructor(dir: string) {
		this.dir = dir;
	}

	/** Initialize a new, isolated git repository */
	static create(): GitRepoFixture {
		const unresolvedDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "git-commits-push-tl-repo-"),
		);
		// Canonicalize so `repo.dir` matches the format the orchestrator's discovery
		// uses internally (via `fs.realpathSync` of search paths and `getWorktrees`
		// via git). On macOS, `fs.mkdtempSync` returns the unresolved
		// `/var/folders/...` path while git canonicalizes to `/private/var/folders/...`,
		// causing path-mismatch failures in tests that compare `repo.dir` against
		// manifest entries.
		const dir = fs.realpathSync(unresolvedDir);
		const fixture = new GitRepoFixture(dir);
		fixture.exec("git init");
		fixture.exec("git config user.email test@example.com");
		fixture.exec("git config user.name Test");
		return fixture;
	}

	/** Create a file and commit it to establish a non-empty history */
	commit(message: string): void {
		const sentinel = path.join(this.dir, ".gitkeep");
		if (!fs.existsSync(sentinel)) {
			fs.writeFileSync(sentinel, "");
		}
		this.exec("git add -A");
		// --no-verify bypasses the user's `core.hooksPath` hooks (commit-msg validator,
		// pre-commit secret scanner, push enforcer) so test fixtures can set up state
		// deterministically regardless of the user's local git hook configuration.
		// The fixture is a TEST primitive, not a real commit — these hooks are not part
		// of the system under test. The publisher's production code commits go through
		// the hooks normally (no `--no-verify`) because that's the user's policy.
		this.exec(`git commit -m "${message}" --allow-empty --no-verify`);
	}

	/** Write a file and stage it with git add */
	writeAndStage(filename: string, content: string): void {
		fs.writeFileSync(path.join(this.dir, filename), content);
		this.exec("git add -A");
	}

	/** Register a remote (does not have to exist on the network) */
	setRemote(name: string, url: string): void {
		this.exec(`git remote add ${name} ${url}`);
	}

	/** Put the repository in a detached HEAD state */
	checkoutDetached(): void {
		// Ensure there is at least one commit before we can detach
		const sha = this.exec("git rev-parse HEAD").trim();
		this.exec(`git checkout --detach ${sha}`);
	}

	/** Remove the temp directory — call in afterAll/afterEach */
	dispose(): void {
		fs.rmSync(this.dir, { recursive: true, force: true });
	}

	private exec(cmd: string): string {
		return execSync(cmd, {
			cwd: this.dir,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	}
}
