#!/usr/bin/env node
import { runQualification } from "../src/modules/qualification/suite.ts";

process.exitCode = (await runQualification()) ? 0 : 1;
