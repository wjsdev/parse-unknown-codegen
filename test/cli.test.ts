import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { writeParsers } from "../src/write";
import { parseAddress } from "./fixtures/address.parsers";
import { parseRole, parseUser } from "./fixtures/user.parsers";

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const loose = (text: string): string =>
  text.replace(/,(\s*[})\]])/g, "$1").replace(/\s+/g, "");

describe("writeParsers", () => {
  it("writes the fixtures", () => {
    const user = writeParsers(
      fixture("user.ts"),
      "test/fixtures/user.ts",
      "./user"
    );
    const address = writeParsers(
      fixture("address.ts"),
      "test/fixtures/address.ts",
      "./address"
    );

    expect(user.refusals).toEqual([]);
    expect(user.count).toBe(4);
    expect(loose(user.code)).toBe(loose(fixture("user.parsers.ts")));
    expect(loose(address.code)).toBe(loose(fixture("address.parsers.ts")));
  });

  it("the parsers parse", () => {
    const wire = {
      id: 1,
      name: "Ann",
      role: "admin",
      deletedAt: null,
      tags: ["a"],
      address: { street: "1 Main St", city: "Springfield" },
      "created-at": "2026-01-01",
      settings: {
        theme: "dark",
        "per-page": 20,
        history: [{ at: "2026-01-01", by: 1 }],
      },
      counts: { a: 1 },
      ids: [1, 2],
      meta: { anything: true },
      flag: "yes",
      status: { "is-active": true, since: null },
    };

    expect(parseUser(wire)).toEqual({
      id: 1,
      name: "Ann",
      email: undefined,
      role: "admin",
      deletedAt: null,
      tags: ["a"],
      address: { street: "1 Main St", city: "Springfield", zip: undefined },
      createdAt: "2026-01-01",
      settings: {
        theme: "dark",
        perPage: 20,
        history: [{ at: "2026-01-01", by: 1 }],
      },
      counts: { a: 1 },
      ids: [1, 2],
      nickname: undefined,
      meta: { anything: true },
      flag: "yes",
      status: { "is-active": true, since: null },
    });
    expect(parseRole("member")).toBe("member");
    expect(() => parseAddress({ street: "1 Main St", city: 1 })).toThrow(
      "city: expected a string, got 1"
    );
  });

  it("refuses by line, writes nothing", () => {
    const source = [
      "export type A = { when: Date };",
      "export type B<T> = { t: T };",
      "type Hidden = { x: number };",
      "export type C = { h: Hidden; u: { a: 1 } | { b: 2 }; p: Partial<A> };",
    ].join("\n");
    const written = writeParsers(source, "types.ts", "./types");

    expect(written.code).toBe("");
    expect(written.count).toBe(0);
    expect(
      written.refusals.map(
        (r) => `${r.line}:${r.column} ${r.where}: ${r.reason}`
      )
    ).toEqual([
      "1:25 A.when: `Date` isn't declared in this file or imported into it",
      "2:8 B: a generic type has no one parser; write each instance out",
      "4:22 C.h: `Hidden` isn't exported, so its parser can't be named; export it",
      "4:33 C.u: an object written inline inside a union: name it",
      "4:57 C.p: `Partial<…>`: a type built from another has no parser; write it out",
    ]);
  });
});
