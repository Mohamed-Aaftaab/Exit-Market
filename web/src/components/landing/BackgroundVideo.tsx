"use client";

import { useEffect, useRef } from "react";
import styles from "./landing.module.css";

/**
 * Full-bleed looping backdrop (our own Blender render, seamless 10 s loop). The poster is the loop's first
 * frame, so there is no flash before playback. React does not reliably emit `muted` in server HTML, and
 * browsers only autoplay muted video, so it is set on the element before play() is called.
 */
export function BackgroundVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.muted = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.pause();
      return;
    }
    video.play().catch(() => undefined); // autoplay refused (data saver, etc.): the poster stays
  }, []);

  return (
    <div className={styles.bg} aria-hidden="true">
      <video ref={ref} className={styles.bgVideo} autoPlay muted loop playsInline preload="auto" poster="/hero/poster.jpg">
        <source src="/hero/loop.webm" type="video/webm" />
        <source src="/hero/loop.mp4" type="video/mp4" />
      </video>
    </div>
  );
}
