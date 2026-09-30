"use client";

import { useEffect, useRef } from "react";
import styles from "./landing.module.css";

/** The hero backdrop from the design, streamed from its CDN; our own rendered loop is the fallback source. */
const DESIGN_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4";

/**
 * Full-bleed looping video behind the hero. It fades in once frames are actually playing, so there is no
 * flash of a poster or a half-loaded frame. React does not reliably emit `muted` in server HTML, and browsers
 * only autoplay muted video, so it is set on the element before play() is called.
 */
export function BackgroundVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const show = () => {
      video.dataset.ready = "true";
    };
    video.addEventListener("playing", show);
    video.addEventListener("loadeddata", show);
    video.muted = true;
    if (video.readyState >= 2) show();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.autoplay = false; // reduced motion: the first frame stays as a still backdrop
      video.pause();
    } else {
      video.play().catch(() => undefined); // autoplay refused (data saver): the first frame stays
    }
    return () => {
      video.removeEventListener("playing", show);
      video.removeEventListener("loadeddata", show);
    };
  }, []);

  return (
    <div className={styles.bg} aria-hidden="true">
      <video ref={ref} className={styles.bgVideo} autoPlay muted loop playsInline preload="auto">
        <source src={DESIGN_VIDEO} type="video/mp4" />
        <source src="/hero/loop.mp4" type="video/mp4" />
      </video>
    </div>
  );
}
