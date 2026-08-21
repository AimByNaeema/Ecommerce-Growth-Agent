# data/tasks/

Transient, per-task-run working data the agent reads or writes while executing a
single task. Not business configuration (`configuration/`), not persisted state
(`memory/state/`) — safe to clear at any time without losing anything durable.

Reusable agent logic must never hardcode contents from this folder; it's disposable
scratch space, not a source of truth.
