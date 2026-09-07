import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KVKK Kurul Kararları — Semantik Arama",
  description:
    "Kişisel Verileri Koruma Kurulu karar özetlerinde anlam tabanlı arama. " +
    "pgvector + Türkçe full-text hybrid retrieval.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
