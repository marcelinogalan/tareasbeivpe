import type { AppProps } from "next/app";
import { useEffect } from "react";
import "@/app/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-blocking for environments where service workers are unavailable.
    });
  }, []);

  return <Component {...pageProps} />;
}
