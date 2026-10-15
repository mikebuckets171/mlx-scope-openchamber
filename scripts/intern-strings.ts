import { parse } from 'acorn';

type Syntax = { type: string; start: number; end: number; [key: string]: unknown };
type Reference = { start: number; end: number; kind: 'value' | 'key' | 'access' | 'optional' };
type Binding = { name: string };
type Scope = { parent?: Scope; function: boolean; bindings: Map<string, Binding> };
const syntax = (value: unknown): value is Syntax => !!value && typeof value === 'object' && typeof (value as Syntax).type === 'string';
const children = (node: Syntax): Syntax[] => Object.values(node).flatMap(value =>
  Array.isArray(value) ? value.filter(syntax) : syntax(value) ? [value] : []);

/** Intern repeated primitive values and property-name strings; never rename a property or serialize a decoder. */
export const internStrings = (source: string): string => {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as Syntax;
  const scopes = new WeakMap<Syntax, Scope>(), declared = new WeakMap<Syntax, Binding>();
  const pattern = (node: Syntax): Syntax[] => node.type === 'Identifier' ? [node]
    : node.type === 'RestElement' && syntax(node.argument) ? pattern(node.argument)
    : node.type === 'AssignmentPattern' && syntax(node.left) ? pattern(node.left)
    : node.type === 'ArrayPattern' && Array.isArray(node.elements) ? node.elements.filter(syntax).flatMap(pattern)
    : node.type === 'ObjectPattern' && Array.isArray(node.properties) ? node.properties.filter(syntax).flatMap(item =>
      syntax(item.value) ? pattern(item.value) : syntax(item.argument) ? pattern(item.argument) : []) : [];
  const declare = (node: Syntax, scope: Scope): void => {
    for (const id of pattern(node)) {
      const name = String(id.name), binding = scope.bindings.get(name) ?? { name };
      scope.bindings.set(name, binding); declared.set(id, binding);
    }
  };
  const index = (node: Syntax, outer: Scope): void => {
    let scope = outer;
    const fn = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
    const cls = node.type === 'ClassDeclaration' || node.type === 'ClassExpression';
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && syntax(node.id)) declare(node.id, outer);
    if (fn || cls || ['BlockStatement', 'CatchClause', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement', 'StaticBlock'].includes(node.type)) {
      scope = { parent: outer, function: fn, bindings: new Map() };
    }
    scopes.set(node, scope);
    if ((node.type === 'FunctionExpression' || node.type === 'ClassExpression') && syntax(node.id)) declare(node.id, scope);
    if (node.type === 'ClassDeclaration' && syntax(node.id)) scope.bindings.set(String(node.id.name), declared.get(node.id)!);
    if (fn && Array.isArray(node.params)) for (const param of node.params.filter(syntax)) declare(param, scope);
    if (node.type === 'CatchClause' && syntax(node.param)) declare(node.param, scope);
    if (node.type === 'VariableDeclaration' && Array.isArray(node.declarations)) {
      let target = scope;
      if (node.kind === 'var') while (!target.function && target.parent) target = target.parent;
      for (const item of node.declarations.filter(syntax)) if (syntax(item.id)) declare(item.id, target);
    }
    for (const child of children(node)) index(child, scope);
  };
  index(tree, { function: true, bindings: new Map() });
  const resolve = (node: Syntax): Binding | undefined => {
    if (node.type !== 'Identifier') return;
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      const binding = scope.bindings.get(String(node.name)); if (binding) return binding;
    }
  };
  const protectedBindings = new Set<Binding>(), bodies = new Set<Syntax>();
  const protectBinding = (node: Syntax): void => { const binding = resolve(node); if (binding) protectedBindings.add(binding); };
  const base = (node: Syntax): Syntax => node.type === 'MemberExpression' && syntax(node.object) ? base(node.object)
    : node.type === 'CallExpression' && syntax(node.callee) ? base(node.callee) : node;
  const discover = (node: Syntax): void => {
    if (node.type === 'MemberExpression' && syntax(node.property) &&
        (node.computed ? node.property.value === 'toString' : node.property.name === 'toString') && syntax(node.object)) {
      if (node.object.type === 'Identifier') protectBinding(node.object);
      if (node.object.type === 'FunctionExpression' || node.object.type === 'ArrowFunctionExpression') bodies.add(node.object);
      if (node.object.type === 'MemberExpression' || node.object.type === 'CallExpression') {
        const owner = base(node.object);
        if (owner.type === 'Identifier') protectBinding(owner);
        else bodies.add(owner);
      }
    }
    for (const child of children(node)) discover(child);
  };
  discover(tree);
  // An object/array member can escape before its function source is read. Protect
  // that initializer and follow ordinary aliases, named callback values and factories.
  // Resolve lexical bindings so an unrelated minified name cannot capture a large
  // subtree. This is not a general analysis of arbitrary reflection/data flow.
  const protect = (node: Syntax): void => {
    bodies.add(node);
    if (node.type === 'Identifier') protectBinding(node);
    else if (node.type === 'CallExpression' && syntax(node.callee)) protect(base(node.callee));
    else if (node.type === 'ObjectExpression' && Array.isArray(node.properties)) {
      for (const item of node.properties.filter(syntax)) {
        if (syntax(item.value)) protect(item.value);
        else if (item.type === 'SpreadElement' && syntax(item.argument)) protect(item.argument);
      }
    } else if (node.type === 'ArrayExpression' && Array.isArray(node.elements)) {
      for (const item of node.elements.filter(syntax)) protect(item);
    } else if (node.type === 'SpreadElement' && syntax(node.argument)) protect(node.argument);
    else if (node.type === 'MemberExpression' && syntax(node.object)) protect(base(node.object));
    else if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression' || node.type === 'SequenceExpression') for (const child of children(node)) protect(child);
  };
  const propagate = (node: Syntax): void => {
    if (node.type === 'VariableDeclarator' && syntax(node.id) && syntax(node.init) && pattern(node.id).some(id => protectedBindings.has(declared.get(id)!))) protect(node.init);
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && syntax(node.id) && protectedBindings.has(declared.get(node.id)!)) bodies.add(node);
    if (node.type === 'AssignmentExpression' && syntax(node.left) && syntax(node.right)) {
      const binding = resolve(base(node.left)); if (binding && protectedBindings.has(binding)) protect(node.right);
    }
    for (const child of children(node)) propagate(child);
  };
  let size = -1;
  while (size !== protectedBindings.size + bodies.size) { size = protectedBindings.size + bodies.size; propagate(tree); }
  const matches = new Map<string, Reference[]>();
  const add = (value: string, ref: Reference): void => { const list = matches.get(value) ?? []; list.push(ref); matches.set(value, list); };
  const collect = (node: Syntax, parent?: Syntax): void => {
    if (bodies.has(node)) return;
    const key = parent && parent.key === node && !parent.computed;
    if (node.type === 'Literal' && typeof node.value === 'string' && !key && !parent?.directive) {
      add(node.value, { start: node.start, end: node.end, kind: 'value' });
    }
    if (node.type === 'MemberExpression' && !node.computed && syntax(node.property) && node.property.type === 'Identifier') {
      add(String(node.property.name), { start: node.property.start - 1, end: node.property.end, kind: node.optional ? 'optional' : 'access' });
    }
    if (node.type === 'Property' && !node.computed && !node.shorthand && syntax(node.key)) {
      const value = node.key.type === 'Identifier' ? node.key.name : node.key.value;
      // Object-literal __proto__ has special prototype-setter semantics. Class/constructor keys are never visited here.
      if (typeof value === 'string' && value !== '__proto__') add(value, { start: node.key.start, end: node.key.end, kind: 'key' });
    }
    for (const child of children(node)) collect(child, node);
  };
  collect(tree);
  let prefix = '__scopeString';
  while (source.includes(prefix)) prefix += '_';
  const edits: Array<{ start: number; end: number; value: string }> = [], declarations: string[] = [];
  for (const [value, nodes] of matches) {
    const cost = JSON.stringify(value).length + 4;
    const saving = nodes.reduce((n, ref) => n + ref.end - ref.start - (ref.kind === 'value' ? 2 : ref.kind === 'optional' ? 5 : 4), 0) - cost;
    if (saving < 12 || nodes.length < 2) continue;
    const name = `${prefix}${declarations.length}`;
    declarations.push(`${name}=${JSON.stringify(value)}`);
    for (const ref of nodes) edits.push({ start: ref.start, end: ref.end,
      value: ref.kind === 'value' ? ` ${name} ` : ref.kind === 'optional' ? `.[${name}]` : `[${name}]` });
  }
  if (!edits.length) return source;
  edits.sort((a, b) => b.start - a.start);
  let result = source;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  // The final minifier encloses the pool and guest together; no name is added to window/globalThis.
  return `const ${declarations.join(',')};${result}`;
};
