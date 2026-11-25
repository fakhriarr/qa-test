import "./only";
import type { Job } from "../contracts";
import { Store } from "./store";
export class Simulator {
  constructor(readonly store: Store) {}
  async receive(job: Job) { await this.store.accept(job); }
  async resume(executionId: string) {
    await this.store.complete(executionId);
    for (const event of await this.store.pending(executionId)) {
      await this.store.callback(event);
      // A lost response leaves this pending; replay checks the persisted receipt.
      await this.store.markDelivered(event.eventId);
    }
  }
}
