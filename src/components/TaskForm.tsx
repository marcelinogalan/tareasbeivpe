"use client";

export type TaskCreateDraft = {
  title: string;
  description: string;
  tags: string;
  assignee: string;
  status: string;
  urgency: string;
  deadline: string;
};

type TaskFormProps = {
  value: TaskCreateDraft;
  onChange: (value: TaskCreateDraft) => void;
  onSubmit: () => Promise<void>;
  loading: boolean;
};

export function TaskForm({ value, onChange, onSubmit, loading }: TaskFormProps) {
  function patch(next: Partial<TaskCreateDraft>) {
    onChange({ ...value, ...next });
  }

  return (
    <form
      className="task-form-grid"
      onSubmit={async (event) => {
        event.preventDefault();
        await onSubmit();
      }}
    >
      <input
        className="task-input"
        value={value.title}
        onChange={(event) => patch({ title: event.target.value })}
        placeholder="Actividad"
      />
      <textarea
        className="task-input task-input-description"
        value={value.description}
        onChange={(event) => patch({ description: event.target.value })}
        placeholder="Descripción"
      />
      <input
        className="task-input"
        value={value.assignee}
        onChange={(event) => patch({ assignee: event.target.value })}
        placeholder="Asignado a"
      />
      <input
        className="task-input"
        value={value.tags}
        onChange={(event) => patch({ tags: event.target.value })}
        placeholder="Etiquetas"
      />
      <select className="task-input" value={value.status} onChange={(event) => patch({ status: event.target.value })}>
        <option value="New">NEW</option>
        <option value="WIP">WIP</option>
        <option value="End">End</option>
        <option value="Blocked">Blocked</option>
      </select>
      <select className="task-input" value={value.urgency} onChange={(event) => patch({ urgency: event.target.value })}>
        <option value="">Urgencia</option>
        <option value="Urgente">Urgente</option>
        <option value="No Urgente">No Urgente</option>
      </select>
      <input
        className="task-input"
        type="date"
        value={value.deadline}
        onChange={(event) => patch({ deadline: event.target.value })}
      />
      <button className="btn btn-primary" type="submit" disabled={loading}>
        {loading ? "Guardando..." : "Añadir actividad"}
      </button>
    </form>
  );
}
