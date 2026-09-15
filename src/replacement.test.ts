import { expect, test } from "bun:test";
import { needsDatabaseReplacement } from "./replacement";

test("a database mode change requires replacement", () => {
  expect(
    needsDatabaseReplacement({
      phase: "update",
      previous: { remote: true, organization: "acme", group: "default" },
      remote: false
    })
  ).toBe(true);
});

test("an unchanged database does not require replacement", () => {
  expect(
    needsDatabaseReplacement({
      phase: "update",
      previous: { remote: true, organization: "acme", group: "default" },
      remote: true,
      organization: "acme",
      group: "default"
    })
  ).toBe(false);
});

test("a remote database name change requires replacement", () => {
  expect(
    needsDatabaseReplacement({
      phase: "update",
      previous: {
        remote: true,
        name: "my-app-dev-db",
        organization: "acme",
        group: "default"
      },
      remote: true,
      name: "my-app-dev-primary-db",
      organization: "acme",
      group: "default"
    })
  ).toBe(true);
});

test("a remote database organization change requires replacement", () => {
  expect(
    needsDatabaseReplacement({
      phase: "update",
      previous: { remote: true, organization: "acme", group: "default" },
      remote: true,
      organization: "other-acme",
      group: "default"
    })
  ).toBe(true);
});

test("a remote database group change requires replacement", () => {
  expect(
    needsDatabaseReplacement({
      phase: "update",
      previous: { remote: true, organization: "acme", group: "default" },
      remote: true,
      organization: "acme",
      group: "replicas"
    })
  ).toBe(true);
});
