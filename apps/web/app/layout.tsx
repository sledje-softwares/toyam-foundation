import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claims Investigation Platform",
  description: "Case management for claims investigation staff.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
