import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { sql, StandardSQL, PostgreSQL, MySQL } from '@codemirror/lang-sql';
import { tags as t } from '@lezer/highlight';
const style = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--cm-keyword)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--cm-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--cm-number)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--cm-type)' },
  { tag: [t.operator, t.punctuation], color: 'var(--cm-op)' },
  { tag: [t.special(t.name), t.quote], color: 'var(--cm-quoted)' },
]);
const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--editor-bg)', fontSize: '14px', height: '100%' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)', padding: '10px 0' },
  '.cm-gutters': { backgroundColor: 'var(--editor-gutter)', color: 'var(--muted)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--editor-active)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--editor-active)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--editor-sel) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-scroller': { overflow: 'auto' },
});
const DIALECTS = { bigquery: StandardSQL, snowflake: StandardSQL, databricks: MySQL, redshift: PostgreSQL, athena: StandardSQL };
function create(parent, opts) {
  opts = opts || {};
  const lang = new Compartment(); const ro = new Compartment();
  const langFor = (d, schema) => sql({ dialect: DIALECTS[d] || StandardSQL, schema: schema || {}, upperCaseKeywords: true });
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: opts.doc || '', extensions: [
      lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(), autocompletion(), highlightActiveLine(), highlightSelectionMatches(),
      keymap.of([...(opts.keys || []), ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      syntaxHighlighting(style), theme, EditorView.lineWrapping, lang.of(langFor(opts.dialect, opts.schema)), ro.of(EditorState.readOnly.of(!!opts.readOnly)),
      placeholder(opts.placeholder || ''),
      EditorView.contentAttributes.of({ 'aria-label': opts.label || 'SQL editor' }),
      EditorView.updateListener.of((u) => { if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString()); }),
    ] }),
  });
  return {
    view,
    get: () => view.state.doc.toString(),
    set: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    setDialect: (d, schema) => view.dispatch({ effects: lang.reconfigure(langFor(d, schema)) }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
window.QCEditor = { create };
