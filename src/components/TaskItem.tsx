"use client";

import { KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";

import { Task } from "@/types/task";

type EditableField = "title" | "description" | "nextSteps" | "notes" | "tags" | "status" | "assignee" | "urgency" | "deadline";
type TextEditableField = "title" | "description" | "nextSteps" | "notes" | "assignee" | "deadline";

type TaskItemProps = {
  task: Task;
  onUpdate: (task: Task, updates: Partial<Task>) => Promise<void>;
  tagOptions: string[];
};

const TEXT_FIELDS: TextEditableField[] = ["title", "description", "nextSteps", "notes", "assignee", "deadline"];

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function isTextField(field: EditableField): field is TextEditableField {
  return TEXT_FIELDS.includes(field as TextEditableField);
}

function fieldLabel(field: TextEditableField): string {
  if (field === "title") return "Actividad";
  if (field === "description") return "Descripción";
  if (field === "nextSteps") return 'Next Steps/Historial "vivo"';
  if (field === "notes") return "Historial";
  if (field === "assignee") return "Asignado a";
  return "Deadline";
}

function renderTextWithLinks(value: string): ReactNode {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const isUrlRegex = /^https?:\/\/[^\s]+$/;
  const lines = value.split("\n");

  return lines.map((line, lineIndex) => {
    const parts = line.split(urlRegex);
    return (
      <span key={`line-${lineIndex}`}>
        {parts.map((part, index) =>
          isUrlRegex.test(part) ? (
            <a key={`part-${lineIndex}-${index}`} href={part} target="_blank" rel="noreferrer">
              {part}
            </a>
          ) : (
            <span key={`part-${lineIndex}-${index}`}>{part}</span>
          )
        )}
        {lineIndex < lines.length - 1 ? <br /> : null}
      </span>
    );
  });
}

export function TaskItem({ task, onUpdate, tagOptions }: TaskItemProps) {
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const [textModalField, setTextModalField] = useState<TextEditableField | null>(null);
  const [textModalValue, setTextModalValue] = useState("");

  const tagEditorRef = useRef<HTMLDivElement | null>(null);

  function startEdit(field: EditableField, value: string) {
    if (saving) return;

    if (isTextField(field)) {
      setTextModalField(field);
      setTextModalValue(value);
      return;
    }

    setEditingField(field);
    if (field === "tags") {
      setDraftTags(parseTags(value));
      setDraftValue("");
      return;
    }

    setDraftValue(value);
    setDraftTags([]);
  }

  async function commitInlineEdit() {
    if (!editingField) return;

    const field = editingField;
    const nextValue = field === "tags" ? draftTags.join(", ") : draftValue.trim();
    const previousValue = String(task[field] || "").trim();

    setEditingField(null);
    if (nextValue === previousValue) {
      return;
    }

    const updates: Partial<Task> = { [field]: nextValue };
    if (field === "status") {
      updates.completed = nextValue.toLowerCase() === "end";
    }

    setSaving(true);
    try {
      await onUpdate(task, updates);
    } finally {
      setSaving(false);
    }
  }

  async function commitTextModalEdit() {
    if (!textModalField) return;

    const field = textModalField;
    const nextValue = textModalValue.trim();
    const previousValue = String(task[field] || "").trim();

    setTextModalField(null);
    if (nextValue === previousValue) {
      return;
    }

    setSaving(true);
    try {
      await onUpdate(task, { [field]: nextValue });
    } finally {
      setSaving(false);
    }
  }

  function cancelInlineEdit() {
    setEditingField(null);
    setDraftValue("");
    setDraftTags([]);
  }

  function cancelTextModalEdit() {
    setTextModalField(null);
    setTextModalValue("");
  }

  function toggleDraftTag(tag: string) {
    setDraftTags((previous) => {
      const exists = previous.some((item) => item.toLowerCase() === tag.toLowerCase());
      if (exists) {
        return previous.filter((item) => item.toLowerCase() !== tag.toLowerCase());
      }
      return [...previous, tag];
    });
  }

  function handleInlineKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitInlineEdit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelInlineEdit();
    }
  }

  function handleModalKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void commitTextModalEdit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelTextModalEdit();
    }
  }

  useEffect(() => {
    if (editingField !== "tags") return;

    function handleClickOutside(event: MouseEvent) {
      if (!tagEditorRef.current) return;
      if (event.target instanceof Node && tagEditorRef.current.contains(event.target)) {
        return;
      }
      void commitInlineEdit();
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [editingField, draftTags]);

  return (
    <>
      <tr className="task-row">
        <td onDoubleClick={() => startEdit("title", task.title)}>
          <span className={task.completed ? "task-title is-completed" : "task-title"}>{renderTextWithLinks(task.title)}</span>
        </td>

        <td onDoubleClick={() => startEdit("description", task.description || "")}>
          {task.description ? renderTextWithLinks(task.description) : "-"}
        </td>

        <td onDoubleClick={() => startEdit("nextSteps", task.nextSteps || "")}>
          {task.nextSteps ? renderTextWithLinks(task.nextSteps) : "-"}
        </td>

        <td className="col-history" onDoubleClick={() => startEdit("notes", task.notes || "")}>
          {task.notes ? renderTextWithLinks(task.notes) : "-"}
        </td>

        <td onDoubleClick={() => startEdit("tags", task.tags || "")}>
          {editingField === "tags" ? (
            <div ref={tagEditorRef} className="tag-cell-editor">
              <button className="tag-cell-trigger" type="button">
                {draftTags.length ? draftTags.join(", ") : "Seleccionar etiquetas"}
              </button>
              <div className="tag-cell-menu">
                {tagOptions.map((option) => {
                  const checked = draftTags.some((tag) => tag.toLowerCase() === option.toLowerCase());
                  return (
                    <label key={option} className="tag-cell-option">
                      <input type="checkbox" checked={checked} onChange={() => toggleDraftTag(option)} />
                      <span>{option}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ) : task.tags ? (
            renderTextWithLinks(task.tags)
          ) : (
            "-"
          )}
        </td>

        <td onDoubleClick={() => startEdit("status", task.status || (task.completed ? "End" : "WIP"))}>
          {editingField === "status" ? (
            <select
              autoFocus
              className="task-input task-input-inline"
              value={draftValue}
              onChange={(event) => setDraftValue(event.target.value)}
              onBlur={() => void commitInlineEdit()}
              onKeyDown={handleInlineKeyDown}
            >
              <option value="WIP">WIP</option>
              <option value="End">End</option>
              <option value="Blocked">Blocked</option>
              <option value="New">New</option>
            </select>
          ) : task.status ? (
            renderTextWithLinks(task.status)
          ) : (
            "-"
          )}
        </td>

        <td onDoubleClick={() => startEdit("assignee", task.assignee || "")}>
          {task.assignee ? renderTextWithLinks(task.assignee) : "-"}
        </td>

        <td onDoubleClick={() => startEdit("urgency", task.urgency || "")}>
          {editingField === "urgency" ? (
            <select
              autoFocus
              className="task-input task-input-inline"
              value={draftValue}
              onChange={(event) => setDraftValue(event.target.value)}
              onBlur={() => void commitInlineEdit()}
              onKeyDown={handleInlineKeyDown}
            >
              <option value="">-</option>
              <option value="Urgente">Urgente</option>
              <option value="No Urgente">No Urgente</option>
            </select>
          ) : task.urgency ? (
            renderTextWithLinks(task.urgency)
          ) : (
            "-"
          )}
        </td>

        <td onDoubleClick={() => startEdit("deadline", task.deadline || "")}>
          {task.deadline ? renderTextWithLinks(task.deadline) : "-"}
        </td>

        <td>{new Date(task.createdAt).toLocaleDateString("es-ES")}</td>
        <td>
          <div className="task-actions">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void onUpdate(task, { status: "End", completed: true })}
              disabled={saving || (task.status || "").toLowerCase() === "end"}
            >
              Completar
            </button>
          </div>
        </td>
      </tr>

      {textModalField ? (
        <tr className="task-popup-row">
          <td colSpan={11}>
            <div className="task-popup">
              <p className="task-popup-title">{fieldLabel(textModalField)}</p>
              <textarea
                autoFocus
                className="task-popup-textarea"
                value={textModalValue}
                onChange={(event) => setTextModalValue(event.target.value)}
                onKeyDown={handleModalKeyDown}
              />
              <div className="task-popup-actions">
                <button className="btn btn-primary" type="button" onClick={() => void commitTextModalEdit()}>
                  Aceptar
                </button>
                <button className="btn btn-ghost" type="button" onClick={cancelTextModalEdit}>
                  Cancelar
                </button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
