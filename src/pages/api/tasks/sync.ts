import type { NextApiRequest, NextApiResponse } from "next";

import { getSyncStatus, runSyncNow } from "@/lib/tasks-store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      const status = await getSyncStatus();
      return res.status(200).json(status);
    }

    if (req.method === "POST") {
      const status = await runSyncNow();
      return res.status(200).json(status);
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "method not allowed" });
  } catch (error) {
    console.error("/api/tasks/sync error", error);
    return res.status(500).json({ error: "sync unavailable" });
  }
}
