import { validateTrustToken } from "../dist/index.js";

process.stdout.write(validateTrustToken(process.argv[2]) ? "valid" : "invalid");
