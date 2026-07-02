// GH #384 (Story 03): tri-state quiescence-bypass status reported by the
// iOS rn-fast-runner at startup (see QuiescenceStatus.swift).
export type QuiescenceStatus = 'active' | 'disabled' | 'unavailable';
