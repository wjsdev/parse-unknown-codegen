#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { writeParsers } from "./write";

const USAGE = `usage: parsers [--check] [--out <dir>] <file.ts>...`;

function main(args: readonly string[]): number {
  let check = false;
  let out: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--check") check = true;
    else if (arg === "--out") {
      out = args[i + 1];
      i += 1;
    } else if (arg.startsWith("-")) {
      console.error(`unknown option ${arg}\n${USAGE}`);
      return 2;
    } else files.push(arg);
  }
  if (files.length === 0 || (out !== undefined && !out)) {
    console.error(USAGE);
    return 2;
  }
  let failed = false;
  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`${file}: no such file`);
      failed = true;
      continue;
    }
    const target = join(
      out ?? dirname(file),
      basename(file).replace(/\.ts$/, ".parsers.ts")
    );
    const from = `./${relative(dirname(target), file).replace(/\.ts$/, "")}`;
    const written = writeParsers(readFileSync(file, "utf8"), file, from);
    for (const refusal of written.refusals)
      console.error(
        `${file}:${refusal.line}:${refusal.column} ${refusal.where}: ${refusal.reason}`
      );
    if (written.refusals.length) {
      failed = true;
      continue;
    }
    if (check) {
      const current = existsSync(target) ? readFileSync(target, "utf8") : "";
      if (loose(current) !== loose(written.code)) {
        console.error(`${target}: stale — run \`parsers ${file}\``);
        failed = true;
      }
      continue;
    }
    writeFileSync(target, written.code);
    console.log(
      `${target}: ${written.count} parser${written.count === 1 ? "" : "s"}`
    );
  }

  return failed ? 1 : 0;
}

function loose(text: string): string {
  return text.replace(/,(\s*[})\]])/g, "$1").replace(/\s+/g, "");
}

process.exit(main(process.argv.slice(2)));
