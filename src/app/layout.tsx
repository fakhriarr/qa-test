import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dashboard QA | Simulasi Agent",
  description: "Dashboard internal untuk simulasi job QA dengan penyimpanan Supabase.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="id"><body>{children}</body></html>;
}
