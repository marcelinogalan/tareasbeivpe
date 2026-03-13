export type Task = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  description?: string;
  nextSteps?: string;
  notes?: string;
  tags?: string;
  assignee?: string;
  status?: string;
  urgency?: string;
  deadline?: string;
  origin?: string;
  country?: string;
  workstream?: string;
  scope?: string;
};
