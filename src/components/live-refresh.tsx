"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * <LiveRefresh interval={10000} /> — calls router.refresh() periodically so
 * a server-rendered page re-fetches without the user pressing reload.
 *
 * Cheap to render (no UI, no state). Pauses when the tab is hidden so a
 * background tab doesn't keep hitting the DB. Resumes when the tab becomes
 * visible again.
 *
 * Drop into any server component to make it feel alive. Don't use on pages
 * with forms — refreshing while typing would clobber input state.
 */
export function LiveRefresh({ interval = 10000 }: { interval?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    function start() {
      if (timer) return;
      timer = setInterval(() => {
        router.refresh();
      }, interval);
    }

    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    function onVisibility() {
      if (document.visibilityState === "visible") start();
      else stop();
    }

    // Start immediately if the tab is in the foreground
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [interval, router]);

  return null;
}
