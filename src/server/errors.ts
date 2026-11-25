import "./only";
export class Fault extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function assert(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new Fault(status, code, message);
}
