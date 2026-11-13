import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const delay = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function waitFor(predicate, message, bound = 15_000) {
	const end = Date.now() + bound;
	while (!predicate()) {
		assert.ok(Date.now() < end, message);
		await delay(10);
	}
}

/** Inspect actual state and birth identity; kill(0) alone is never a live/absent oracle. */
export function processRow(pid) {
	const result = spawnSync(
		"/bin/ps",
		["-p", String(pid), "-o", "pid=,ppid=,pgid=,stat=,lstart="],
		{ encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
	);
	assert.ifError(result.error);
	if (result.status === 1 && !result.stdout.trim()) return null;
	assert.equal(result.status, 0);
	const parts = result.stdout.trim().split(/\s+/);
	return {
		pid: Number(parts[0]),
		ppid: Number(parts[1]),
		pgid: Number(parts[2]),
		state: parts[3],
		birth: parts.slice(4).join(" "),
	};
}
export function groupExists(pgid) {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		if (error.code === "EPERM") return true;
		throw error;
	}
}

/** Real compiled controller, its own session and explicitly named fixture descendants. */
export async function controllerFixture({
	mode = "resist",
	owner = false,
	unknown = false,
	observation,
} = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "gcp-controller-lifetime-"));
	const messages = [],
		identities = new Map();
	const write = (name, text) => {
		const target = path.join(root, name);
		writeFileSync(target, text);
		return target;
	};
	const child = write(
		"child.mjs",
		`
 import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
 const role=process.argv[2];
 if(process.env.MODE==='resist'||process.env.MODE==='grandchild')process.on('SIGTERM',()=>{});
 writeFileSync(process.env.FIXTURE_ROOT+'/'+role+'.json',JSON.stringify({pid:process.pid,ppid:process.ppid}));
 if(process.env.MODE==='grandchild'&&role==='child')spawn(process.execPath,[import.meta.filename,'grandchild'],{stdio:'inherit'});
 setInterval(()=>{},1000);
 `,
	);
	const zombie = write(
		"zombie.py",
		`import os,signal,json,time\nsignal.signal(signal.SIGTERM,lambda *_:None)\npid=os.fork()\nif pid==0: os._exit(0)\nopen(os.environ['FIXTURE_ROOT']+'/zombie.json','w').write(json.dumps({'pid':pid,'holder':os.getpid()}))\nwhile True: time.sleep(1)\n`,
	);
	const supervisor = write(
		"supervisor.mjs",
		`
 import {spawn} from 'node:child_process';
 if(process.env.MODE==='quiet')process.exit(0);
 if(process.env.MODE==='zombie'){process.on('SIGTERM',()=>{});spawn('python3',[${JSON.stringify(zombie)}],{stdio:'inherit'});}
 else spawn(process.execPath,[${JSON.stringify(child)},'child'],{stdio:'inherit'});
 `,
	);
	const unknownHook = write(
		"unknown.mjs",
		`
 import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
 const original=cp.spawnSync;
 cp.spawnSync=function(command,args,...rest){
  if(command==='/bin/ps'&&args.join(' ')==='-axo pid=,pgid='){
   const pid=process.pid, inspector=pid+1000000;
   const self=pid+' '+pid+'\\n';
   const values={empty:'',blank:' \\t\\n',malformed:'broken row\\n',mixed:self+'bad '+pid+'\\n',
    'missing-controller':inspector+' '+pid+'\\n','wrong-controller-group':pid+' '+(pid+1)+'\\n',
    'valid-controller':self+inspector+' '+pid+'\\n'};
   if(process.env.OBSERVATION==='unavailable')return undefined;
   if(process.env.OBSERVATION)return {status:0,stdout:values[process.env.OBSERVATION],pid:inspector};
   return {status:1,stdout:'',stderr:'synthetic unknown',error:undefined};
  }
  return original.call(this,command,args,...rest);
 };syncBuiltinESMExports();
 `,
	);
	const controller = path.resolve(
		import.meta.dirname,
		"../../../dist/src/entrypoints/execution-controller.js",
	);
	const options = {
		cwd: root,
		detached: true,
		env: {
			...process.env,
			MODE: mode,
			FIXTURE_ROOT: root,
			...(observation ? { OBSERVATION: observation } : {}),
		},
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		execArgv: unknown || observation ? ["--import", unknownHook] : [],
	};
	const ownerScript = write(
		"owner.mjs",
		`
 import {fork} from 'node:child_process';
 const child=fork(${JSON.stringify(controller)},[${JSON.stringify(supervisor)}],{cwd:process.env.FIXTURE_ROOT,detached:true,env:process.env,stdio:['ignore','ignore','ignore','ipc'],execArgv:[]});
 process.send({type:'FIXTURE_CONTROLLER',pid:child.pid});
 child.on('message',m=>{if(process.connected)process.send(m);});
 process.on('message',m=>child.send(m));
 `,
	);
	const processHandle = owner
		? fork(ownerScript, [], {
				env: options.env,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
				execArgv: [],
			})
		: fork(controller, [supervisor], options);
	let pid = owner ? undefined : processHandle.pid;
	let exit = null;
	processHandle.on("exit", (code, signal) => {
		exit = { code, signal };
	});
	processHandle.on("message", (message) => {
		messages.push(message);
		if (message.type === "FIXTURE_CONTROLLER") pid = message.pid;
	});
	await waitFor(() => pid !== undefined, "controller PID missing");
	const initial = processRow(pid);
	assert.ok(initial);
	identities.set(pid, initial);
	const send = (type) =>
		processHandle.send({
			type,
			version: 1,
			token: "independent-lifetime-fixture",
		});
	const remember = (role) => {
		const file = path.join(root, role + ".json");
		if (!existsSync(file)) return null;
		const value = JSON.parse(readFileSync(file, "utf8"));
		const row = processRow(value.pid);
		if (row) identities.set(row.pid, row);
		if (value.holder) {
			const holder = processRow(value.holder);
			if (holder) identities.set(holder.pid, holder);
		}
		return row;
	};
	return {
		pid,
		messages,
		get exit() {
			return exit;
		},
		send,
		disconnect: () => processHandle.disconnect(),
		killOwner: () => {
			assert.ok(owner);
			processHandle.kill("SIGKILL");
		},
		async prepare() {
			send("PREPARE");
			await waitFor(
				() => messages.some((m) => m.type === "READY"),
				"READY missing",
			);
		},
		async start() {
			send("START");
			await waitFor(
				() => messages.some((m) => m.type === "STARTED"),
				"STARTED missing",
			);
			if (mode !== "quiet")
				await waitFor(
					() => remember(mode === "zombie" ? "zombie" : "child"),
					"child missing",
				);
			if (mode === "grandchild")
				await waitFor(() => remember("grandchild"), "grandchild missing");
		},
		row: processRow,
		remember,
		killSupervisor() {
			const message = messages.find((m) => m.type === "STARTED");
			assert.ok(message);
			process.kill(message.supervisorPid, "SIGKILL");
		},
		async cleanup() {
			const leader = processRow(pid);
			if (leader && leader.birth === initial.birth && leader.pgid === pid)
				process.kill(-pid, "SIGKILL");
			// On a RED, the leader may already be gone: signal only individually birth-verified fixture descendants.
			for (const [childPid, identity] of identities) {
				const live = processRow(childPid);
				if (
					live &&
					live.birth === identity.birth &&
					live.pgid === pid &&
					!live.state.startsWith("Z")
				) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch (e) {
						if (e.code !== "ESRCH") throw e;
					}
				}
			}
			if (
				owner &&
				processHandle.exitCode === null &&
				processHandle.signalCode === null
			)
				processHandle.kill("SIGKILL");
			await waitFor(
				() => !groupExists(pid),
				"fixture group remained after investigator cleanup",
			);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
