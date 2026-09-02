import type { Metadata } from "next";

import { APP_NAME } from "@webhook/shared";

import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Phase 0 scaffold — web application health check.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        {children}
      </body>
    </html>
  );
}
