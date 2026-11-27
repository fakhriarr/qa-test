import type { Metadata } from "next";
import "./globals.css";
import { DashboardSessionProvider } from "@/components/session-gate";

export const metadata: Metadata = {
  title: "Dashboard QA | OpenBot",
  description: "Dashboard internal untuk mengirim permintaan pengujian ke agent QA OpenBot dan memantau hasilnya.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="id"><body><DashboardSessionProvider>{children}</DashboardSessionProvider></body></html>;
}
