#!/usr/bin/env node
import { runNodeWithPlatformGit } from "../src/modules/qualification/platform-git.ts";

const result = await runNodeWithPlatformGit(process.argv.slice(2));
if (result.signal !== null) process.kill(process.pid, result.signal);
else process.exitCode = result.exitCode ?? 1;
