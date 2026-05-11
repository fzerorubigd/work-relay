import { describe, expect, test } from "bun:test";

import { parseInitialRooms } from "../src/config.js";

describe("parseInitialRooms", () => {
  test("argv --rooms=foo,bar parses both", () => {
    const warned: string[] = [];
    const rooms = parseInitialRooms(["--rooms=foo,bar"], {}, (m) => warned.push(m));
    expect(rooms).toEqual(["foo", "bar"]);
    expect(warned).toEqual([]);
  });

  test("argv --rooms foo,bar (separate value) parses both", () => {
    const warned: string[] = [];
    const rooms = parseInitialRooms(["--rooms", "foo,bar"], {}, (m) => warned.push(m));
    expect(rooms).toEqual(["foo", "bar"]);
    expect(warned).toEqual([]);
  });

  test("env WORK_RELAY_ROOMS used when argv absent", () => {
    const warned: string[] = [];
    const rooms = parseInitialRooms([], { WORK_RELAY_ROOMS: "general,review" }, (m) => warned.push(m));
    expect(rooms).toEqual(["general", "review"]);
    expect(warned).toEqual([]);
  });

  test("argv wins when both argv and env present", () => {
    const warned: string[] = [];
    const rooms = parseInitialRooms(
      ["--rooms=from-argv"],
      { WORK_RELAY_ROOMS: "from-env" },
      (m) => warned.push(m),
    );
    expect(rooms).toEqual(["from-argv"]);
    expect(warned).toEqual([]);
  });

  test("empty / missing flag returns empty list", () => {
    const warned: string[] = [];
    const rooms = parseInitialRooms([], {}, (m) => warned.push(m));
    expect(rooms).toEqual([]);
    expect(warned).toEqual([]);
  });

  test("invalid room name is dropped + warned, valid ones survive", () => {
    const warned: string[] = [];
    const rooms = parseInitialRooms(
      ["--rooms=valid,invalid name,also-valid_1"],
      {},
      (m) => warned.push(m),
    );
    expect(rooms).toEqual(["valid", "also-valid_1"]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("invalid name");
  });

  test("whitespace around names is trimmed", () => {
    const warned: string[] = [];
    const rooms = parseInitialRooms(["--rooms= foo , bar "], {}, (m) => warned.push(m));
    expect(rooms).toEqual(["foo", "bar"]);
    expect(warned).toEqual([]);
  });

  test("over-long room name (>64 chars) is dropped + warned", () => {
    const warned: string[] = [];
    const tooLong = "a".repeat(65);
    const rooms = parseInitialRooms([`--rooms=${tooLong},shortname`], {}, (m) => warned.push(m));
    expect(rooms).toEqual(["shortname"]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(tooLong);
  });

  test("argv with empty value falls through to env (not to empty-list)", () => {
    // `--rooms=` with empty value: extractRoomsArg returns "", which split
    // produces a single empty entry, filtered out → empty list. Env is
    // NOT consulted because argv was present (operator's explicit empty
    // overrides env, matching standard CLI semantics).
    const warned: string[] = [];
    const rooms = parseInitialRooms(
      ["--rooms="],
      { WORK_RELAY_ROOMS: "from-env" },
      (m) => warned.push(m),
    );
    expect(rooms).toEqual([]);
    expect(warned).toEqual([]);
  });
});
