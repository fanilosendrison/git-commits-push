import { test } from "bun:test";
import { spawnSync } from "child_process";
test("env test", () => {
    console.log("In test:", process.env.PI_SKILL_STATS_MODE);
    const res = spawnSync("bun", ["-e", "console.log('Child:', process.env.PI_SKILL_STATS_MODE)"], { env: process.env, encoding: "utf-8" });
    console.log(res.stdout);
});
