import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";

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
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-commits-push-tl-repo-"));
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
		this.exec(`git commit -m "${message}" --allow-empty`);
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
		return execSync(cmd, { cwd: this.dir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
	}
}
