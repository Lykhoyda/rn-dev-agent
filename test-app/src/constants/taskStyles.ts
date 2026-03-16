import type { TaskPriority } from '../store/slices/tasksSlice';

export const PRIORITY_STYLES: Record<TaskPriority, { bg: string; text: string; label: string }> = {
  high: { bg: 'bg-red-100', text: 'text-red-700', label: 'High' },
  medium: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'Med' },
  low: { bg: 'bg-green-100', text: 'text-green-700', label: 'Low' },
};
