import Link from "next/link";
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
            intone
          </Link>
          <span className="badge">{RELEASE.npmVersion ? `v${RELEASE.npmVersion}` : "Private preview"}</span>
          {!docs ? (
            <nav aria-label="Demos">
              <a href="/#direct">Direct</a>
              <a href="/#stream">Streaming</a>
              <a href="/#voices">Voices</a>
              <a href="/#sing">Singing</a>
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
            intone
          </Link>
          <nav aria-label="Footer">
            <Link href={LINKS.start}>Get started</Link>
            <Link href={LINKS.docs}>Documentation</Link>
            <a href={LINKS.examples}>Live demos</a>
            {RELEASE.npmVersion ? <a href={LINKS.npm}>npm</a> : <span>npm release coming soon</span>}
          </nav>
        </div>
        <p>
          A JavaScript library for speech you can direct. The physical voice model is{" "}
          <a href={LINKS.engine}>CHIMERA</a> by <a href={LINKS.author}>Jameson Hodge</a>, MIT licensed.
        </p>
      </div>
    </footer>
  );
}
