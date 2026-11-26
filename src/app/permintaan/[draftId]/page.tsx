"use client";

import { useParams } from "next/navigation";
import SessionGate from "@/components/session-gate";
import RequestWizard from "@/components/request-wizard";

export default function ResumeDraftPage() {
  const params = useParams<{ draftId: string }>();
  const draftId = Array.isArray(params.draftId) ? params.draftId[0] : params.draftId;

  return <SessionGate>{context => <RequestWizard context={context} draftId={draftId} />}</SessionGate>;
}