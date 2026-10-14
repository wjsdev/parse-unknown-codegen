import type {
  Comment,
  ImportDeclaration,
  PropertyKey,
  Statement,
  TSInterfaceDeclaration,
  TSLiteral,
  TSSignature,
  TSType,
  TSTypeAliasDeclaration,
} from "oxc-parser";
import { parseSync } from "oxc-parser";

export type Written = {
  code: string;
  count: number;
  refusals: Refusal[];
};

export type Refusal = {
  line: number;
  column: number;
  where: string;
  reason: string;
};

type Scope = {
  text: string;
  comments: readonly Comment[];
  from: string;
  library: string;
  exported: Set<string>;
  local: Set<string>;
  imported: Map<string, string>;
  used: Set<string>;
  typesFromHere: Set<string>;
  parsersFromElsewhere: Map<string, Set<string>>;
  functions: string[];
  refusals: Refusal[];
};

export function writeParsers(
  text: string,
  file: string,
  from: string,
  library = "parse-unknown"
): Written {
  const { program, errors, comments } = parseSync(file, text);
  const scope: Scope = {
    text,
    comments,
    from,
    library,
    exported: new Set(),
    local: new Set(),
    imported: new Map(),
    used: new Set(),
    typesFromHere: new Set(),
    parsersFromElsewhere: new Map(),
    functions: [],
    refusals: [],
  };
  for (const error of errors) {
    const start = error.labels[0]?.start ?? 0;
    scope.refusals.push({
      ...position(text, start),
      where: file,
      reason: error.message,
    });
  }
  for (const statement of program.body) register(scope, statement);
  for (const statement of program.body) {
    const declared = declaration(statement);
    if (declared) parserFor(scope, declared);
  }
  if (scope.refusals.length)
    return { code: "", count: 0, refusals: scope.refusals };

  return {
    code: assemble(scope, file),
    count: scope.functions.length,
    refusals: [],
  };
}

function register(scope: Scope, statement: Statement): void {
  if (statement.type === "ImportDeclaration") {
    registerImport(scope, statement);
    return;
  }
  if (statement.type === "ExportNamedDeclaration") {
    const declared = statement.declaration;
    if (
      declared?.type === "TSTypeAliasDeclaration" ||
      declared?.type === "TSInterfaceDeclaration"
    )
      scope.exported.add(declared.id.name);
    return;
  }
  if (
    statement.type === "TSTypeAliasDeclaration" ||
    statement.type === "TSInterfaceDeclaration"
  )
    scope.local.add(statement.id.name);
}

function registerImport(scope: Scope, statement: ImportDeclaration): void {
  for (const specifier of statement.specifiers ?? []) {
    if (specifier.type !== "ImportSpecifier") continue;
    scope.imported.set(specifier.local.name, statement.source.value);
  }
}

function declaration(
  statement: Statement
): TSTypeAliasDeclaration | TSInterfaceDeclaration | undefined {
  if (statement.type !== "ExportNamedDeclaration") return undefined;
  const declared = statement.declaration;
  if (
    declared?.type === "TSTypeAliasDeclaration" ||
    declared?.type === "TSInterfaceDeclaration"
  )
    return declared;

  return undefined;
}

function parserFor(
  scope: Scope,
  declared: TSTypeAliasDeclaration | TSInterfaceDeclaration
): void {
  const name = declared.id.name;
  if (declared.typeParameters) {
    refuse(
      scope,
      declared.start,
      name,
      "a generic type has no one parser; write each instance out"
    );
    return;
  }
  scope.typesFromHere.add(name);
  if (declared.type === "TSInterfaceDeclaration") {
    if (declared.extends.length) {
      refuse(
        scope,
        declared.start,
        name,
        "an interface that extends another: write its keys out"
      );
      return;
    }
    exportedObject(scope, declared.body.body, declared.body.start, name);
    return;
  }
  const type = declared.typeAnnotation;
  if (type.type === "TSTypeLiteral") {
    exportedObject(scope, type.members, type.start, name);
    return;
  }
  const parse = parserOf(scope, type, name, name, pascal(name), 1);
  if (parse === undefined) return;
  scope.functions.push(
    `export function parse${pascal(name)}(value: unknown): ${name} {\n  return ${parse}(value);\n}\n`
  );
}

function exportedObject(
  scope: Scope,
  members: readonly TSSignature[],
  start: number,
  name: string
): void {
  const record = objectParser(
    scope,
    members,
    start,
    name,
    name,
    pascal(name),
    1
  );
  if (record === undefined) return;
  scope.functions.push(
    `export function parse${pascal(name)}(value: unknown): ${name} {\n  return ${record}(value);\n}\n`
  );
}

function objectParser(
  scope: Scope,
  members: readonly TSSignature[],
  start: number,
  name: string,
  where: string,
  hint: string,
  indent: number
): string | undefined {
  const lines: string[] = [];
  const inner = "  ".repeat(indent + 1);
  let previousEnd = start;
  for (const member of members) {
    if (member.type !== "TSPropertySignature") {
      refuse(
        scope,
        member.start,
        where,
        "only properties have parsers; no methods, no index signatures"
      );
      previousEnd = member.end;
      continue;
    }
    const key = keyOf(member.key);
    if (key === undefined || member.computed) {
      refuse(scope, member.start, where, "a key that isn't a plain name");
      previousEnd = member.end;
      continue;
    }
    const type = member.typeAnnotation?.typeAnnotation;
    if (!type) {
      refuse(scope, member.start, `${where}.${key}`, "no type");
      previousEnd = member.end;
      continue;
    }
    const tag = wireTag(scope, previousEnd, member.start);
    previousEnd = member.end;
    const parse = parserOf(
      scope,
      type,
      `${name}[${quote(key)}]`,
      `${where}.${key}`,
      `${hint}${pascal(key)}`,
      indent + 1
    );
    if (parse === undefined) continue;
    const parser = member.optional
      ? `${use(scope, "optional")}(${parse})`
      : parse;
    lines.push(
      `${inner}${property(key)}: ${tag === undefined ? parser : `${use(scope, "from")}(${quote(tag)}, ${parser})`},`
    );
  }
  if (scope.refusals.length) return undefined;

  return `${use(scope, "object")}({\n${lines.join("\n")}\n${"  ".repeat(indent)}} satisfies ${use(scope, "ParsersOf")}<${name}>)`;
}

function parserOf(
  scope: Scope,
  type: TSType,
  at: string,
  where: string,
  hint: string,
  indent: number
): string | undefined {
  switch (type.type) {
    case "TSStringKeyword":
      return use(scope, "string");
    case "TSNumberKeyword":
      return use(scope, "number");
    case "TSBooleanKeyword":
      return use(scope, "boolean");
    case "TSNullKeyword":
      return use(scope, "nil");
    case "TSUnknownKeyword":
      return use(scope, "unknown");
    case "TSLiteralType": {
      const literal = literalOf(type.literal);
      if (literal === undefined) {
        refuse(
          scope,
          type.start,
          where,
          "a literal that isn't a string, a number or a boolean"
        );
        return undefined;
      }
      return `${use(scope, "literal")}([${literal}])`;
    }
    case "TSParenthesizedType":
      return parserOf(scope, type.typeAnnotation, at, where, hint, indent);
    case "TSTypeOperator":
      if (type.operator === "readonly")
        return parserOf(scope, type.typeAnnotation, at, where, hint, indent);
      refuse(scope, type.start, where, `\`${type.operator}\` has no parser`);
      return undefined;
    case "TSArrayType": {
      const item = parserOf(
        scope,
        type.elementType,
        `${at}[number]`,
        `${where}[]`,
        hint,
        indent
      );
      return item === undefined ? undefined : `${use(scope, "array")}(${item})`;
    }
    case "TSTypeLiteral":
      return objectParser(
        scope,
        type.members,
        type.start,
        at,
        where,
        hint,
        indent
      );
    case "TSUnionType":
      return unionParser(
        scope,
        type.types,
        at,
        where,
        hint,
        type.start,
        indent
      );
    case "TSTypeReference":
      return referenceParser(scope, type, at, where, hint, indent);
    default:
      refuse(
        scope,
        type.start,
        where,
        `${describe(type.type)} has no parser; write this one yourself`
      );
      return undefined;
  }
}

function unionParser(
  scope: Scope,
  types: readonly TSType[],
  at: string,
  where: string,
  hint: string,
  start: number,
  indent: number
): string | undefined {
  const literals: string[] = [];
  const others: string[] = [];
  let nullable = false;
  let optional = false;
  for (const member of types) {
    if (member.type === "TSNullKeyword") {
      nullable = true;
      continue;
    }
    if (member.type === "TSUndefinedKeyword") {
      optional = true;
      continue;
    }
    if (member.type === "TSLiteralType") {
      const literal = literalOf(member.literal);
      if (literal === undefined) {
        refuse(
          scope,
          member.start,
          where,
          "a literal that isn't a string, a number or a boolean"
        );
        return undefined;
      }
      literals.push(literal);
      continue;
    }
    if (member.type === "TSTypeLiteral") {
      refuse(
        scope,
        member.start,
        where,
        "an object written inline inside a union: name it"
      );
      return undefined;
    }
    const parse = parserOf(scope, member, at, where, hint, indent);
    if (parse === undefined) return undefined;
    others.push(parse);
  }
  const parts = [
    ...(literals.length
      ? [`${use(scope, "literal")}([${literals.join(", ")}])`]
      : []),
    ...others,
  ];
  if (parts.length === 0) {
    refuse(scope, start, where, "a union of nothing but null or undefined");
    return undefined;
  }
  let parse =
    parts.length === 1
      ? parts[0]
      : `${use(scope, "either")}(${parts.join(", ")})`;
  if (nullable) parse = `${use(scope, "nullable")}(${parse})`;
  if (optional)
    parse = `${use(scope, "either")}(${parse}, ${use(scope, "nothing")})`;

  return parse;
}

function referenceParser(
  scope: Scope,
  type: TSType & { type: "TSTypeReference" },
  at: string,
  where: string,
  hint: string,
  indent: number
): string | undefined {
  const named = type.typeName;
  if (named.type !== "Identifier") {
    refuse(scope, type.start, where, "a qualified name (`A.B`) has no parser");
    return undefined;
  }
  const args = type.typeArguments?.params ?? [];
  if (named.name === "Array" || named.name === "ReadonlyArray") {
    if (args.length !== 1) {
      refuse(
        scope,
        type.start,
        where,
        `\`${named.name}\` with ${args.length} type arguments`
      );
      return undefined;
    }
    const item = parserOf(
      scope,
      args[0],
      `${at}[number]`,
      `${where}[]`,
      hint,
      indent
    );
    return item === undefined ? undefined : `${use(scope, "array")}(${item})`;
  }
  if (named.name === "Record") {
    if (args.length !== 2 || args[0].type !== "TSStringKeyword") {
      refuse(scope, type.start, where, "only `Record<string, T>` has a parser");
      return undefined;
    }
    const item = parserOf(
      scope,
      args[1],
      `${at}[string]`,
      `${where}[string]`,
      hint,
      indent
    );
    return item === undefined ? undefined : `${use(scope, "record")}(${item})`;
  }
  if (args.length) {
    refuse(
      scope,
      type.start,
      where,
      `\`${named.name}<…>\`: a type built from another has no parser; write it out`
    );
    return undefined;
  }
  if (scope.exported.has(named.name)) return `parse${pascal(named.name)}`;
  const module = scope.imported.get(named.name);
  if (module !== undefined) {
    if (!module.startsWith(".")) {
      refuse(
        scope,
        type.start,
        where,
        `\`${named.name}\` comes from a package; only types from your own files have parsers`
      );
      return undefined;
    }
    const parsers = `${module.replace(/\.ts$/, "")}.parsers`;
    const names = scope.parsersFromElsewhere.get(parsers) ?? new Set<string>();
    names.add(`parse${pascal(named.name)}`);
    scope.parsersFromElsewhere.set(parsers, names);
    return `parse${pascal(named.name)}`;
  }
  if (scope.local.has(named.name)) {
    refuse(
      scope,
      type.start,
      where,
      `\`${named.name}\` isn't exported, so its parser can't be named; export it`
    );
    return undefined;
  }
  refuse(
    scope,
    type.start,
    where,
    `\`${named.name}\` isn't declared in this file or imported into it`
  );
  return undefined;
}

function wireTag(
  scope: Scope,
  after: number,
  before: number
): string | undefined {
  let found: string | undefined;
  for (const comment of scope.comments) {
    if (comment.start < after || comment.end > before) continue;
    const tag = /@wire\s+(\S+)/.exec(comment.value);
    if (tag) found = tag[1];
  }

  return found;
}

function keyOf(key: PropertyKey): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;

  return undefined;
}

function literalOf(literal: TSLiteral): string | undefined {
  if (literal.type !== "Literal") return undefined;
  const { value } = literal;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return JSON.stringify(value);

  return undefined;
}

function use(scope: Scope, name: string): string {
  scope.used.add(name);

  return name;
}

function refuse(
  scope: Scope,
  start: number,
  where: string,
  reason: string
): void {
  scope.refusals.push({ ...position(scope.text, start), where, reason });
}

function position(
  text: string,
  offset: number
): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");

  return { line, column };
}

function describe(type: string): string {
  const words = type
    .replace(/^TS/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

  return `a ${words.replace(/ keyword$/, "")}`;
}

function pascal(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function property(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function assemble(scope: Scope, file: string): string {
  const names = [...scope.used].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
  const lines = [
    `// generated by parse-unknown-codegen from ./${file.split("/").pop()} — do not edit`,
    `import { ${names.map((n) => (n === "ParsersOf" ? "type ParsersOf" : n)).join(", ")} } from ${quote(scope.library)};`,
  ];
  const elsewhere = [
    ...[...scope.parsersFromElsewhere].map(
      ([module, parsers]): [string, string] => [
        module,
        `import { ${[...parsers].sort().join(", ")} } from ${quote(module)};`,
      ]
    ),
    [
      scope.from,
      `import type { ${[...scope.typesFromHere].sort().join(", ")} } from ${quote(scope.from)};`,
    ],
  ].sort(([a], [b]) => a.localeCompare(b));
  for (const [, line] of elsewhere) lines.push(line);
  lines.push("", ...scope.functions);

  return `${lines.join("\n").trimEnd()}\n`;
}
