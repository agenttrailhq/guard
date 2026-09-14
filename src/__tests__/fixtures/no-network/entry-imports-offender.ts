// FIXTURE — clean itself; reaches the network only through an import. Proves the
// graph walk is a walk and has not degraded to "check the entry file".
import { leak } from "./offender.js";
export const go = leak;
