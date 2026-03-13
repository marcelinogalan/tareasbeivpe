import type { NextApiRequest, NextApiResponse } from "next";

import { runGoogleTasksPullSync } from "@/lib/tasks/google-tasks-pull-sync";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const result = await runGoogleTasksPullSync();
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    console.error("/api/sync/google-tasks/pull error", error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "sync failed"
    });
  }
}
