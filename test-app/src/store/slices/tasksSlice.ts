import { createSlice, createSelector } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

export type TaskFilter = 'all' | 'active' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskSort = 'default' | 'priority';

export interface TaskItem {
  id: string;
  title: string;
  done: boolean;
  synced: boolean;
  priority: TaskPriority;
}

export interface PendingDelete {
  id: string;
  task: TaskItem;
  insertIndex: number;
}

interface TasksState {
  items: TaskItem[];
  filter: TaskFilter;
  sort: TaskSort;
  pendingDelete: PendingDelete | null;
}

const initialState: TasksState = {
  items: [
    { id: '1', title: 'Review pull request', done: false, synced: true, priority: 'high' },
    { id: '2', title: 'Update documentation', done: false, synced: true, priority: 'low' },
    { id: '3', title: 'Fix navigation bug', done: true, synced: true, priority: 'medium' },
  ],
  filter: 'all',
  sort: 'default',
  pendingDelete: null,
};

const tasksSlice = createSlice({
  name: 'tasks',
  initialState,
  reducers: {
    addTask: (state, action: PayloadAction<string>) => {
      let maxId = state.items.reduce((m, t) => Math.max(m, Number(t.id)), 0);
      if (state.pendingDelete) {
        maxId = Math.max(maxId, Number(state.pendingDelete.task.id));
      }
      state.items.unshift({
        id: String(maxId + 1),
        title: action.payload,
        done: false,
        synced: false,
        priority: 'medium',
      });
    },
    toggleTask: (state, action: PayloadAction<string>) => {
      const task = state.items.find((t) => t.id === action.payload);
      if (task) {
        task.done = !task.done;
        task.synced = false;
      }
    },
    removeTask: (state, action: PayloadAction<string>) => {
      state.items = state.items.filter((t) => t.id !== action.payload);
    },
    setFilter: (state, action: PayloadAction<TaskFilter>) => {
      state.filter = action.payload;
    },
    markAllSynced: (state) => {
      state.items.forEach((t) => { t.synced = true; });
    },
    cyclePriority: (state, action: PayloadAction<string>) => {
      const task = state.items.find((t) => t.id === action.payload);
      if (task) {
        const cycle: Record<TaskPriority, TaskPriority> = { low: 'medium', medium: 'high', high: 'low' };
        task.priority = cycle[task.priority];
        task.synced = false;
      }
    },
    toggleSort: (state) => {
      state.sort = state.sort === 'default' ? 'priority' : 'default';
    },
    softDelete: (state, action: PayloadAction<string>) => {
      const idx = state.items.findIndex((t) => t.id === action.payload);
      if (idx === -1) return;
      state.pendingDelete = { id: action.payload, task: state.items[idx], insertIndex: idx };
      state.items.splice(idx, 1);
    },
    restoreTask: (state) => {
      if (!state.pendingDelete) return;
      const { task, insertIndex } = state.pendingDelete;
      const idx = Math.min(insertIndex, state.items.length);
      state.items.splice(idx, 0, task);
      state.pendingDelete = null;
    },
    commitDelete: (state) => {
      state.pendingDelete = null;
    },
  },
});

export const { addTask, toggleTask, removeTask, setFilter, markAllSynced, cyclePriority, toggleSort, softDelete, restoreTask, commitDelete } = tasksSlice.actions;

export const selectActiveTaskCount = createSelector(
  (state: { tasks: TasksState }) => state.tasks.items,
  (items) => items.filter((t) => !t.done).length,
);

export const selectFilteredTasks = createSelector(
  (state: { tasks: TasksState }) => state.tasks.items,
  (state: { tasks: TasksState }) => state.tasks.filter,
  (items, filter) => {
    if (filter === 'active') return items.filter((t) => !t.done);
    if (filter === 'done') return items.filter((t) => t.done);
    return items;
  },
);

const PRIORITY_WEIGHT: Record<TaskPriority, number> = { high: 0, medium: 1, low: 2 };

export const selectSortedFilteredTasks = createSelector(
  selectFilteredTasks,
  (state: { tasks: TasksState }) => state.tasks.sort,
  (filtered, sort) => {
    if (sort === 'priority') {
      return [...filtered].sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]);
    }
    return filtered;
  },
);

export const selectUnsyncedCount = createSelector(
  (state: { tasks: TasksState }) => state.tasks.items,
  (items) => items.filter((t) => !t.synced).length,
);

export const selectCurrentFilter = (state: { tasks: TasksState }) =>
  state.tasks.filter;

export const selectCurrentSort = (state: { tasks: TasksState }) =>
  state.tasks.sort;

export const selectPendingDelete = (state: { tasks: TasksState }) =>
  state.tasks.pendingDelete;

export default tasksSlice;
