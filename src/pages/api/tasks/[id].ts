import type { NextApiRequest, NextApiResponse } from "next";

import { removeTask, updateTask } from "@/lib/tasks-store";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = typeof req.query.id === "string" ? req.query.id : "";

  if (!id) {
    return res.status(400).json({ error: "id is required" });
  }

  try {
    if (req.method === "PATCH") {
      const payload = {
        title: typeof req.body?.title === "string" ? req.body.title.trim() : undefined,
        completed: typeof req.body?.completed === "boolean" ? req.body.completed : undefined,
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
      };

      const hasAnyField = Object.values(payload).some((value) => typeof value !== "undefined");
      if (!hasAnyField) {
        return res.status(400).json({ error: "at least one field is required" });
      }

      if (typeof payload.title === "string" && !payload.title) {
        return res.status(400).json({ error: "title cannot be empty" });
      }

      const task = await updateTask(id, payload);
      if (!task) {
        return res.status(404).json({ error: "task not found" });
      }

      return res.status(200).json({ task });
    }

    if (req.method === "DELETE") {
      const deleted = await removeTask(id);
      if (!deleted) {
        return res.status(404).json({ error: "task not found" });
      }

      return res.status(204).end();
    }

    res.setHeader("Allow", ["PATCH", "DELETE"]);
    return res.status(405).json({ error: "method not allowed" });
  } catch (error) {
    console.error(`/api/tasks/${id} error`, error);
    return res.status(500).json({ error: "tasks backend unavailable" });
  }
}
