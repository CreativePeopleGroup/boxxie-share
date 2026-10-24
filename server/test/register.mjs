// Lets Node load the Worker code by faking the `cloudflare:workers` module.
import { register } from "node:module";

const fake = `export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }`;
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(fake)}), shortCircuit: true };
  }
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));
