"use client";

import { useParams } from "next/navigation";
import SessionGate from "@/components/session-gate";
import JobDetail from "@/components/job-detail";

export default function JobPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = Array.isArray(params.jobId) ? params.jobId[0] : params.jobId;
  return <SessionGate>{context => <JobDetail jobId={jobId} context={context} />}</SessionGate>;
}
