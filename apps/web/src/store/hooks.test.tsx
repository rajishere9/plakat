// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useEditor, useEditorActions } from './editor-store.ts';
import { selectSelectedElements, selectSelectionBounds } from './selectors.ts';
import { makeStore, rect } from './test-helpers.ts';

describe('React hooks', () => {
  it('useEditor re-renders on selected state only, with stable derived selectors', () => {
    const { store } = makeStore([rect('a', 0, 0, 10, 10)]);
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return { els: useEditor(selectSelectedElements, store), bounds: useEditor(selectSelectionBounds, store), actions: useEditorActions(store) };
    });
    expect(result.current.els).toEqual([]);
    const before = renders;
    act(() => store.getState().actions.setHovered('a'));
    expect(renders).toBe(before);
    act(() => result.current.actions.select(['a']));
    expect(result.current.els.map((e) => e.id)).toEqual(['a']);
    expect(result.current.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });
});
