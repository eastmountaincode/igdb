import type { Metadata } from "next";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const styles = readFileSync(join(process.cwd(), "src/app/igdb.css"), "utf8");

export const metadata: Metadata = {
  title: "Normal Shopkeep",
  description: "File transport through Instagram video frames."
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
