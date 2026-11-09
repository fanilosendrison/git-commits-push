import { test } from "node:test";
import { frozenAuthorityCase } from "../fixtures/prepared-merge-negative-cases.ts";

for (const mutation of ["M11", "M12", "M13", "M19"])
	test(`${mutation}: incomplete ownership, split planning or foreign history is refused`, () =>
		frozenAuthorityCase(mutation));
