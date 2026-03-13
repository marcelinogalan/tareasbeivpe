import type { NextApiRequest, NextApiResponse } from "next";

import { addTask, listTasks } from "@/lib/tasks-store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      const tasks = await listTasks();
      return res.status(200).json({ tasks });
    }

    if (req.method === "POST") {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) {
        return res.status(400).json({ error: "title is required" });
      }

      const task = await addTask({
        title,
        description: typeof req.body?.description === "string" ? req.body.description.trim() : undefined,
        nextSteps: typeof req.body?.nextSteps === "string" ? req.body.nextSteps.trim() : undefined,
        notes: typeof req.body?.notes === "string" ? req.body.notes.trim() : undefined,
        tags: typeof req.body?.tags === "string" ? req.body.tags.trim() : undefined,
        assignee: typeof req.body?.assignee === "string" ? req.body.assignee.trim() : undefined,
        status: typeof req.body?.status === "string" ? req.body.status.trim() : undefined,
        urgency: typeof req.body?.urgency === "string" ? req.body.urgency.trim() : undefined,
        deadline: typeof req.body?.deadline === "string" ? req.body.deadline.trim() : undefined,
        origin: typeof req.body?.origin === "string" ? req.body.origin.trim() : undefined,
        country: typeof req.body?.country === "string" ? req.body.country.trim() : undefined,
        workstream: typeof req.body?.workstream === "string" ? req.body.workstream.trim() : undefined,
        scope: typeof req.body?.scope === "string" ? req.body.scope.trim() : undefined
      });
      return res.status(201).json({ task });
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ error: "method not allowed" });
  } catch (error) {
    console.error("/api/tasks error", error);
    return res.status(500).json({ error: "tasks backend unavailable" });
  }
}
