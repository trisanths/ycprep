import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YC Interviewer",
  description: "A focused YC interview practice room with grading, recordings, and history."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
