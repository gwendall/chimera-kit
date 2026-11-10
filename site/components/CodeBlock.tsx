"use client";
import { useEffect, useRef, useState } from "react";
import styles from "./CodeBlock.module.css";

export function CodeBlock({
  children: code,
  language = "TypeScript",
}: {
  children: string;
  language?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className={styles.block}>
      <div className={styles.bar}>
        <span>{language}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1600);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy code"}
        </button>
      </div>
      <pre className="code">
        <code>{code}</code>
      </pre>
    </div>
  );
}
