import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/server.js";

const config = {
  stateRoot: "/tmp/private-prime-state",
  paperclipApiUrl: "http://127.0.0.1:3100",
  port: 4319,
  executable: "/opt/prime-runtime/prime-agent",
  executableSha256: "a".repeat(64),
  runtimeRoot: "/opt/prime-runtime",
  runtimeSha256: "b".repeat(64),
};

describe("standalone Prime BFF configuration", () => {
  it("requires explicit pinned native inputs and a loopback Paperclip authority", () => {
    expect(parseConfig(config)).toEqual(config);
    expect(() => parseConfig({ ...config, executableSha256: "auto" })).toThrow();
    expect(() => parseConfig({ ...config, paperclipApiUrl: "https://paperclip.example" })).toThrow();
    expect(() => parseConfig({ ...config, port: 0 })).toThrow();
    expect(() => parseConfig({ ...config, extraService: true })).toThrow();
  });
});
