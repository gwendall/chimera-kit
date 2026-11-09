import type { Metadata } from "next";
import Link from "next/link";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: `Not found: ${BRAND.name}` };

export default function NotFound() {
  return (
    <main style={{ minHeight: "100svh", display: "grid", placeContent: "center", gap: 24, padding: 24 }}>
      <h1
        style={{
          fontFamily: "var(--font-serif)",
          fontWeight: 400,
          fontSize: "clamp(48px, 9vw, 96px)",
          margin: 0,
        }}
      >
        Nothing to say here.
      </h1>
      <Link href="/" style={{ color: "var(--heat)" }}>
        Back to the voice
      </Link>
    </main>
  );
}
