import { test } from "node:test";
import { frozenAuthorityCase } from "../fixtures/prepared-merge-negative-cases.ts";

for (const mutation of ["M08", "M09", "M14", "M15", "M16"])
	test(`${mutation}: changed source, target or endpoint cannot authorize a merge`, () =>
		frozenAuthorityCase(mutation));
