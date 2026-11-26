"use client";

import SessionGate from "@/components/session-gate";
import RequestWizard from "@/components/request-wizard";

export default function NewRequestPage() {
  return <SessionGate>{context => <RequestWizard context={context} />}</SessionGate>;
}