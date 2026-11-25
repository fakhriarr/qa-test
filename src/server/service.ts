import "./only";
import { Store } from "./store";
import { Simulator } from "./simulator";
import { Fault } from "./errors";
export class Service {
  constructor(readonly store: Store, readonly simulator: Simulator) {}
  async dispatch(id: string, action: "dispatch" | "retry" | "reconcile") {
    const claim = await this.store.claim(id, action);
    try {
      if (claim.requiresReconciliation) {
        const lookup = await this.store.lookup(claim.job.executionId);
        if (lookup.kind === "not_found") await this.simulator.receive(claim.job);
      } else await this.simulator.receive(claim.job);
      await this.simulator.resume(claim.job.executionId);
      return (await this.store.outcome(id, claim.attemptId, "accepted")).job;
    } catch (error) {
      // Failure can occur after a remote commit: never infer rejection or change execution identity.
      try { await this.store.outcome(id, claim.attemptId, "unknown"); }
      catch { throw new Fault(503, "RECONCILIATION_REQUIRED", "Koneksi data terputus. Muat ulang; rekonsiliasi setelah lease berakhir."); }
      if (error instanceof Fault && [401, 403, 404, 409].includes(error.status)) throw error;
      throw new Fault(503, "RECONCILIATION_REQUIRED", "Outcome belum pasti. Muat ulang status lalu lakukan rekonsiliasi.");
    }
  }
}
