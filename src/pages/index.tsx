import Head from "next/head";
import { TaskApp } from "@/components/TaskApp";

export default function HomePage() {
  return (
    <>
      <Head>
        <title>Tarea BEI VPE</title>
        <meta name="description" content="Gestor de tareas y actividades BEI VPE" />
        <meta name="theme-color" content="#0a3baf" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="/manifest.webmanifest" />
      </Head>
      <main>
        <TaskApp />
      </main>
    </>
  );
}
