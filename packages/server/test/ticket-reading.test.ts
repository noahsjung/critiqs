import { expect, test } from "bun:test";
import type { TicketStatus } from "@critiqs/core";
import { decideReading, type HeldReading, type StatusReading } from "../src/tickets/status.ts";

const DONE: TicketStatus = { label: "Done", category: "done" };
const STARTED: TicketStatus = { label: "In Progress", category: "started" };
const DELETED: TicketStatus = { label: "Deleted", category: "canceled" };

const held = (asOf: number | undefined, status: TicketStatus, deleted = false): HeldReading => ({ asOf, status, deleted });
const webhook = (asOf: number, status: TicketStatus, deleted = false): StatusReading => ({ source: "webhook", asOf, status, deleted });
const check = (asOf: number, status: TicketStatus): StatusReading => ({ source: "check", asOf, status, deleted: false });

test("a newer reading replaces the held one, and an older one never does, from either source", () => {
  expect(decideReading(null, webhook(1, DONE))).toBe("replace");
  expect(decideReading(held(undefined, STARTED), check(1, STARTED))).toBe("replace");
  expect(decideReading(held(10, STARTED), webhook(11, DONE))).toBe("replace");
  expect(decideReading(held(10, STARTED), check(11, STARTED))).toBe("replace");
  expect(decideReading(held(10, DELETED, true), webhook(11, STARTED))).toBe("replace");
  expect(decideReading(held(10, STARTED), webhook(9, DONE))).toBe("keep");
  expect(decideReading(held(10, STARTED), check(9, DONE))).toBe("keep");
  expect(decideReading(held(10, STARTED), webhook(9, DELETED, true))).toBe("keep");
});

test("at the same time, a deletion wins; a webhook's other status or replay changes nothing; a check replaces another status and refreshes the same one", () => {
  expect(decideReading(held(10, DONE), webhook(10, DELETED, true))).toBe("replace");
  expect(decideReading(held(10, DELETED, true), webhook(10, DONE))).toBe("keep");
  expect(decideReading(held(10, DELETED, true), check(10, DONE))).toBe("keep");
  expect(decideReading(held(10, DONE), webhook(10, DONE))).toBe("keep");
  expect(decideReading(held(10, DELETED, true), webhook(10, DELETED, true))).toBe("keep");
  expect(decideReading(held(10, DONE), webhook(10, STARTED))).toBe("keep");
  expect(decideReading(held(10, DONE), check(10, DONE))).toBe("refresh");
  expect(decideReading(held(10, DONE), check(10, STARTED))).toBe("replace");
});
