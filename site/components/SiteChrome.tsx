import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { LINKS, RELEASE } from "@/lib/links";
import styles from "./SiteChrome.module.css";

export function SiteHeader({ docs = false }: { docs?: boolean }) {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top-bar">
        <div className="wrap top">
          <Link className="wordmark" href={LINKS.home}>
            {BRAND.name}
          </Link>
          <span className="badge">{RELEASE.npmVersion ? `v${RELEASE.npmVersion}` : "Private preview"}</span>
          {!docs ? (
            <nav aria-label="Demos">
              <a href="/#direct">Speech</a>
              <a href="/#sing">Singing</a>
              <a href="/#instrument">Instrument</a>
              <a href="/#creatures">Creatures</a>
              <a href="/#agents">Agents</a>
            </nav>
          ) : null}
          <Link href={LINKS.docs} className={styles.docsLink} aria-current={docs ? "page" : undefined}>
            Docs
          </Link>
        </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className="wrap">
        <div className={styles.footerTop}>
          <Link className="wordmark" href={LINKS.home}>
            {BRAND.name}
          </Link>
          <nav aria-label="Footer">
            <Link href={LINKS.start}>Get started</Link>
            <Link href={LINKS.docs}>Documentation</Link>
            <a href={LINKS.examples}>Live demos</a>
            <a href={LINKS.source}>GitHub</a>
            {RELEASE.npmVersion ? <a href={LINKS.npm}>npm</a> : <span>npm release coming soon</span>}
          </nav>
        </div>
        <p>
          The JavaScript toolkit for Chimera. Built on the physical voice model{" "}
          <a href={LINKS.engine}>CHIMERA</a> by <a href={LINKS.author}>Jameson Hodge</a>, MIT licensed.
        </p>
      </div>
    </footer>
  );
}
