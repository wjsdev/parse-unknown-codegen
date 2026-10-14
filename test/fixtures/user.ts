import type { Address } from "./address";

export type User = {
  id: number;
  name: string;
  email?: string;
  role: "admin" | "member";
  deletedAt: string | null;
  tags: string[];
  address: Address;
  /** @wire created-at */
  createdAt: string;
  settings: {
    theme: "light" | "dark";
    /** @wire per-page */
    perPage: number;
    history: Array<{ at: string; by: number }>;
  };
  counts: Record<string, number>;
  ids: readonly number[];
  nickname: string | undefined;
  meta: unknown;
  flag: 1 | true | "yes";
  status: Status;
};

export interface Status {
  "is-active": boolean;
  since: string | null;
}

export type Role = "admin" | "member";

export type Tags = string[];
