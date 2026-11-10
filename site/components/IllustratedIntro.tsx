import Image from "next/image";
import type { ReactNode } from "react";
import styles from "./IllustratedIntro.module.css";

export function IllustratedIntro({
  scene,
  children,
}: {
  scene: "direct" | "stream" | "sing" | "tools";
  children: ReactNode;
}) {
  const hero = scene === "direct";
  return (
    <div className={`${styles.layout} ${hero ? styles.hero : ""}`}>
      <div className={`intro ${styles.copy}`}>{children}</div>
      <Image
        src={`/illustrations/${scene}.webp`}
        alt=""
        width={640}
        height={640}
        className={styles.art}
        loading={hero ? "eager" : "lazy"}
        decoding="async"
        sizes={hero ? "(max-width: 640px) 112px, 280px" : "(max-width: 640px) 104px, 220px"}
      />
    </div>
  );
}
