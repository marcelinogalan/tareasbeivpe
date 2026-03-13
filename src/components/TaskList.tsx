"use client";

import { TaskItem } from "@/components/TaskItem";
import { Task } from "@/types/task";

type TaskListProps = {
  tasks: Task[];
  onUpdate: (task: Task, updates: Partial<Task>) => Promise<void>;
  tagOptions: string[];
};

export function TaskList({ tasks, onUpdate, tagOptions }: TaskListProps) {
  if (!tasks.length) {
    return (
      <section className="empty-state">
        <p className="empty-title">Sin actividades visibles</p>
        <p className="empty-subtitle">Añade una actividad para comenzar a gestionar tu tabla.</p>
      </section>
    );
  }

  return (
    <div className="task-table-wrap">
      <table className="task-table">
        <colgroup>
          <col className="task-col-normal" />
          <col className="task-col-wide" />
          <col className="task-col-wide" />
          <col className="task-col-wide" />
          <col className="task-col-normal" />
          <col className="task-col-normal" />
          <col className="task-col-normal" />
          <col className="task-col-normal" />
          <col className="task-col-normal" />
          <col className="task-col-normal" />
          <col className="task-col-normal" />
        </colgroup>
        <thead>
          <tr>
            <th>Actividad</th>
            <th>Descripción</th>
            <th>Next Steps/Historial "vivo"</th>
            <th className="col-history">Historial</th>
            <th>Etiquetas</th>
            <th>Estado</th>
            <th>Asignado a</th>
            <th>Urgencia</th>
            <th>Deadline</th>
            <th>Fecha registro</th>
            <th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} onUpdate={onUpdate} tagOptions={tagOptions} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
