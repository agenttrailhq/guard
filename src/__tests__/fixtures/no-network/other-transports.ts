// FIXTURE — proves the fence is not fetch-only. `node:https` is the one that would
// otherwise sneak past a fetch-shaped regex.
import { request } from "node:https";
export const send = request;
