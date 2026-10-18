// What a failure may say to a browser or an agent. Validation errors from a
// Durable Object arrive over RPC as plain Errors with readable messages; storage
// and runtime errors (SQL, TypeErrors) are logged and replaced.

const INTERNAL = /SQLITE|no such (table|column)|constraint failed|D1_|internal error|Network connection lost|is not a function|Cannot read propert|undefined is not|is not defined/i;

export function publicMessage(err: unknown): { message: string; internal: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  if (INTERNAL.test(message)) {
    console.error(err);
    return { message: "Something went wrong on our side. Try again.", internal: true };
  }
  return { message, internal: false };
}
