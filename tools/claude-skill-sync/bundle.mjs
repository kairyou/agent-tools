import { parse } from "acorn";
import { createHash } from "node:crypto";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const children = (node) => Object.values(node).flatMap((value) => Array.isArray(value)
  ? value.filter((child) => child?.type) : value?.type ? [value] : []);
function* walk(node) {
  yield node;
  for (const child of children(node)) yield* walk(child);
}
const key = (property) => property.key?.name ?? property.key?.value;
const property = (object, name) => object.properties.find((entry) => key(entry) === name)?.value;
const callable = (node) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node?.type);
function* localNodes(node) {
  yield node;
  if (callable(node)) return;
  for (const child of children(node)) yield* localNodes(child);
}

function rejectWrittenBindings(body, bindings) {
  for (const node of localNodes(body)) {
    const target = node.type === "AssignmentExpression" ? node.left
      : node.type === "UpdateExpression" ? node.argument : null;
    if (target?.type === "Identifier" && bindings.has(target.name)) bindings.get(target.name).written = true;
  }
}

// Modules are data, not imported JavaScript. Resolve dependencies by their exact
// exported names, rejecting ambiguous modules rather than guessing bundle paths.
function modulesFromBundle(bundle) {
  const modules = [];
  const marker = Buffer.from("// @bun");
  for (let start = bundle.indexOf(marker); start >= 0; start = bundle.indexOf(marker, start + marker.length)) {
    const nul = bundle.indexOf(0, start);
    const source = bundle.subarray(start, nul < 0 ? bundle.length : nul).toString("utf8");
    const footer = /export\s*\{([^}]+)\}\s*;?\s*$/.exec(source);
    if (!footer) continue;
    const exports = new Map(footer[1].split(",").map((entry) => {
      const [local, exported = local] = entry.trim().split(/\s+as\s+/);
      return [exported, local];
    }));
    modules.push({ source, exports, hash: hash(source) });
  }
  if (!modules.length) throw new Error("No embedded JavaScript modules with exports found in official bundle");
  return modules;
}

class StaticReader {
  constructor(modules) {
    this.modules = modules;
    this.overrides = new Map();
    this.used = new Set();
    this.active = new Set();
    // Bound interpretation independently of upstream loops or recursion.
    this.remaining = 100000;
  }
  prepare(module) {
    if (module.bindings) return;
    module.ast = parse(module.source, { ecmaVersion: "latest", sourceType: "module" });
    module.bindings = new Map();
    for (const node of module.ast.body) {
      if (node.type === "VariableDeclaration") {
        for (const entry of node.declarations) if (entry.id.type === "Identifier") {
          module.bindings.set(entry.id.name, { node: entry.init, module, duplicate: module.bindings.has(entry.id.name) });
        }
      } else if (node.type === "FunctionDeclaration") {
        module.bindings.set(node.id.name, { node, module });
      } else if (node.type === "ImportDeclaration") {
        const names = node.specifiers.map((entry) => entry.imported?.name);
        for (const entry of node.specifiers) module.bindings.set(entry.local.name, {
          imported: entry.imported?.name, names, module,
        });
      }
    }
    rejectWrittenBindings(module.ast, module.bindings);
  }
  binding(name, module, env) {
    if (env?.has(name)) return env.get(name);
    this.prepare(module);
    const binding = module.bindings.get(name);
    if (!binding) throw new Error(`Unknown official binding: ${name}`);
    if (binding.imported) {
      const candidates = this.modules.filter((item) => binding.names.every((id) => item.exports.has(id)));
      if (candidates.length !== 1) throw new Error(`Ambiguous imported module for ${name}: ${candidates.length}`);
      const target = candidates[0];
      return this.binding(target.exports.get(binding.imported), target);
    }
    return binding;
  }
  read(binding) {
    if (this.overrides.has(binding)) return this.overrides.get(binding);
    if (binding.written || binding.duplicate) throw new Error("Mutable or duplicate official binding");
    if (Object.hasOwn(binding, "value")) return binding.value;
    if (this.active.has(binding)) throw new Error("Cyclic official binding");
    this.active.add(binding);
    try { return this.eval(binding.node, binding.module, binding.env); }
    finally { this.active.delete(binding); }
  }
  eval(node, module, env = new Map()) {
    if (--this.remaining <= 0) throw new Error("Official static interpretation budget exceeded");
    this.used.add(module.hash);
    const visit = (child) => this.eval(child, module, env);
    if (callable(node)) return { kind: "function", node, module, env };
    switch (node?.type) {
      case "Identifier":
        if (node.name === "undefined") return undefined;
        return this.read(this.binding(node.name, module, env));
      case "Literal":
        if (node.regex || node.bigint) break;
        return node.value;
      case "TemplateLiteral":
        return node.quasis.map((part, i) => {
          if (part.value.cooked === null) throw new Error("Invalid official template escape");
          return part.value.cooked + (i < node.expressions.length ? String(visit(node.expressions[i])) : "");
        }).join("");
      case "ConditionalExpression": return visit(node.test) ? visit(node.consequent) : visit(node.alternate);
      case "LogicalExpression":
        if (node.operator === "&&") return visit(node.left) && visit(node.right);
        if (node.operator === "||") return visit(node.left) || visit(node.right);
        if (node.operator === "??") return visit(node.left) ?? visit(node.right);
        break;
      case "UnaryExpression":
        if (node.operator === "!") return !visit(node.argument);
        if (node.operator === "void") { visit(node.argument); return undefined; }
        break;
      case "BinaryExpression": {
        const a = visit(node.left), b = visit(node.right);
        if (node.operator === "+") return a + b;
        if (node.operator === "===") return a === b;
        if (node.operator === "!==") return a !== b;
        break;
      }
      case "ArrayExpression": return node.elements.map(visit);
      case "ObjectExpression": {
        const result = Object.create(null);
        for (const entry of node.properties) {
          if (entry.type !== "Property" || entry.computed || entry.kind !== "init") throw new Error("Unsupported official object property");
          result[key(entry)] = visit(entry.value);
        }
        return result;
      }
      case "MemberExpression": {
        const object = visit(node.object), name = node.computed ? visit(node.property) : node.property.name;
        if (!object || !Object.hasOwn(object, name) || ["constructor", "prototype", "__proto__"].includes(name)) break;
        return object[name];
      }
      case "CallExpression":
        if (node.optional || node.arguments.some((arg) => arg.type === "SpreadElement")) break;
        if (node.callee.type === "MemberExpression") {
          const object = visit(node.callee.object), name = node.callee.property.name;
          if (!node.callee.computed && typeof object === "string" && name === "trim" && !node.arguments.length) return object.trim();
          break;
        }
        return this.call(visit(node.callee), node.arguments.map(visit));
    }
    throw new Error(`Unsupported official expression: ${node?.type}${node?.operator ? ` (${node.operator})` : ""}`);
  }
  environment(fn, args = []) {
    const env = new Map(fn.env);
    for (let i = 0; i < fn.node.params.length; i++) {
      const param = fn.node.params[i];
      const id = param.type === "AssignmentPattern" ? param.left : param;
      if (id.type !== "Identifier") throw new Error("Unsupported official function parameter");
      const value = args[i] === undefined && param.type === "AssignmentPattern"
        ? this.eval(param.right, fn.module, env) : args[i];
      env.set(id.name, { value });
    }
    return env;
  }
  locals(fn, env) {
    // Only direct declarations belong to this function's execution environment.
    for (const statement of fn.node.body.body || []) if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) if (declaration.id.type === "Identifier") {
        env.set(declaration.id.name, { node: declaration.init, module: fn.module, env });
      }
    }
    rejectWrittenBindings(fn.node.body, env);
    return env;
  }
  call(fn, args) {
    if (fn?.kind === "constant-function") return fn.value;
    if (fn?.kind !== "function") throw new Error("Official call target is not a static function");
    const env = this.environment(fn, args);
    if (fn.node.body.type !== "BlockStatement") return this.eval(fn.node.body, fn.module, env);
    const result = this.statement(fn.node.body, fn.module, env);
    return result?.value;
  }
  statement(node, module, env) {
    if (--this.remaining <= 0) throw new Error("Official static interpretation budget exceeded");
    switch (node.type) {
      case "ReturnStatement": return { value: node.argument ? this.eval(node.argument, module, env) : undefined };
      case "BlockStatement":
        for (const statement of node.body) { const result = this.statement(statement, module, env); if (result) return result; }
        return;
      case "VariableDeclaration":
        for (const entry of node.declarations) {
          if (entry.id.type !== "Identifier") throw new Error("Unsupported official declaration");
          env.set(entry.id.name, { value: entry.init ? this.eval(entry.init, module, env) : undefined });
        }
        return;
      case "IfStatement": {
        const branch = this.eval(node.test, module, env) ? node.consequent : node.alternate;
        return branch ? this.statement(branch, module, env) : undefined;
      }
      case "SwitchStatement": {
        const value = this.eval(node.discriminant, module, env);
        const branch = node.cases.find((entry) => entry.test && this.eval(entry.test, module, env) === value)
          || node.cases.find((entry) => !entry.test);
        if (!branch) throw new Error(`No official review variant: ${value}`);
        return this.statement({ type: "BlockStatement", body: branch.consequent }, module, env);
      }
    }
    throw new Error(`Unsupported official statement: ${node.type}`);
  }
}

function one(values, label) {
  if (values.length !== 1) throw new Error(`Expected one ${label}, found ${values.length}`);
  return values[0];
}

export function extractOfficialSkills(bundle) {
  const modules = modulesFromBundle(bundle);
  const reader = new StaticReader(modules);
  const commands = new Map();
  for (const module of modules.filter((item) => item.source.includes("getPromptForCommand") && /code-review|\/simplify/.test(item.source))) {
    reader.prepare(module);
    for (const node of walk(module.ast)) {
      if (node.type !== "ObjectExpression" || !property(node, "getPromptForCommand") || !property(node, "name")) continue;
      let name;
      try { name = reader.eval(property(node, "name"), module); } catch { continue; }
      if (!["code-review", "simplify"].includes(name)) continue;
      if (commands.has(name)) throw new Error(`Duplicate official command: ${name}`);
      commands.set(name, reader.eval(property(node, "getPromptForCommand"), module));
    }
  }
  const review = commands.get("code-review"), simplify = commands.get("simplify");
  if (!review || !simplify) throw new Error("Missing official code-review or simplify registration");
  const routers = [];
  for (const call of walk(review.node.body)) {
    if (call.type !== "CallExpression" || call.callee.type !== "Identifier") continue;
    let fn;
    try { fn = reader.eval(call.callee, review.module); } catch { continue; }
    if (fn?.kind !== "function") continue;
    if ([...walk(fn.node.body)].some((node) => node.type === "SwitchStatement" &&
      ["low", "medium", "high", "xhigh", "max"].every((value) => node.cases.some((entry) => entry.test?.value === value)))) {
      routers.push({ fn, call });
    }
  }
  const { fn: router, call } = one(routers, "review effort router");
  const env = reader.locals(review, reader.environment(review, ["", Object.create(null)]));
  // The router's explicit interface selects the portable variant. Resolve its
  // runtime predicates from the command call site rather than minified names.
  for (const [index, value] of [[2, true], [3, false]]) {
    const argument = call.arguments[index];
    if (argument?.type !== "Identifier") throw new Error("Review runtime selector changed");
    const binding = reader.binding(argument.name, review.module, env);
    const predicate = binding.node;
    if (predicate?.type !== "CallExpression" || predicate.callee.type !== "Identifier") throw new Error("Review runtime predicate changed");
    reader.overrides.set(reader.binding(predicate.callee.name, review.module, env), { kind: "constant-function", value });
  }
  const output = reader.eval(call.arguments[1], review.module, env);
  const reviewText = reader.call(router, ["high", output, true, false, 10]);
  const outputText = reader.call(output, [10]);
  const fixNames = [...walk(review.node.body)].filter((node) => node.type === "Property" && key(node) === "fix" && node.value.type === "Identifier")
    .map((node) => node.value.name);
  const fixBranch = one([...walk(review.node.body)].filter((node) => node.type === "ConditionalExpression" &&
    node.test.type === "Identifier" && fixNames.includes(node.test.name) && node.consequent.type === "CallExpression"), "fix-flag branch");
  const fixes = reader.eval(fixBranch.consequent, review.module, env);
  const blocks = reader.call(simplify, ["", Object.create(null)]);
  if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0].type !== "text") throw new Error("Unexpected simplify output blocks");
  const texts = { review: reviewText, output: outputText, fixes, simplify: blocks[0].text };
  for (const [name, text] of Object.entries(texts)) if (typeof text !== "string" || !text.trim()) throw new Error(`Empty official ${name}`);
  return {
    selection: { effort: "high", agentAvailable: true, hostReporting: false, maxFindings: 10 },
    moduleHashes: [...reader.used].sort(),
    texts: Object.fromEntries(Object.entries(texts).map(([name, text]) => {
      const normalized = text.replaceAll("\r\n", "\n").trim();
      return [name, { text: normalized, sha256: hash(normalized) }];
    })),
  };
}
