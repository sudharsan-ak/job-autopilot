import type { AtsAdapter } from "./types.js";
import { ashbyAdapter } from "./ashby.js";
import { gemAdapter } from "./gem.js";
import { genericAdapter } from "./generic.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { ripplingAdapter } from "./rippling.js";
import { workableAdapter } from "./workable.js";
import { workdayAdapter } from "./workday.js";

export const ATS_ADAPTERS: AtsAdapter[] = [
  greenhouseAdapter,
  ashbyAdapter,
  leverAdapter,
  workableAdapter,
  ripplingAdapter,
  gemAdapter,
  workdayAdapter,
  genericAdapter,
];
