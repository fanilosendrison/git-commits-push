const { spawnSync } = require("child_process");
const res = spawnSync("bun", ["run", "test-env.js"], { env: process.env, encoding: "utf-8" });
console.log("Child says:", res.stdout);
