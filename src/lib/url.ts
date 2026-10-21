import type { CompareMode, ViewMode } from './types';

export interface AppState {
  mode: CompareMode;
  view: ViewMode;
  selected: string[];
}

const DEFAULTS: AppState = { mode: 'region-to-country', view: 'map', selected: [] };

function readState(): AppState {
  if (typeof window === 'undefined') return DEFAULTS;
  const p = new URLSearchParams(window.location.search);
  const mode = p.get('mode');
  const view = p.get('view');
  const selected = (p.get('sel') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    mode: mode === 'country-to-region' ? 'country-to-region' : 'region-to-country',
    view: view === 'globe' ? 'globe' : 'map',
    selected
  };
}

export function loadState(): AppState {
  return readState();
}

export function writeState(state: AppState): void {
  const p = new URLSearchParams();
  if (state.mode !== DEFAULTS.mode) p.set('mode', state.mode);
  if (state.view !== DEFAULTS.view) p.set('view', state.view);
  if (state.selected.length) p.set('sel', state.selected.join(','));
  const query = p.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}

export function shareUrl(state: AppState): string {
  const p = new URLSearchParams();
  if (state.mode !== DEFAULTS.mode) p.set('mode', state.mode);
  if (state.view !== DEFAULTS.view) p.set('view', state.view);
  if (state.selected.length) p.set('sel', state.selected.join(','));
  const query = p.toString();
  return `${window.location.origin}${window.location.pathname}${query ? `?${query}` : ''}`;
}
