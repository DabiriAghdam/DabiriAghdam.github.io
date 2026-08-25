import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Amir's AI Assistant API",
  description: "The secure Groq gateway for AmirHossein DabiriAghdam's personal website.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
