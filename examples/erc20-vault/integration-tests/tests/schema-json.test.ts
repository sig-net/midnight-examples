import { expect, it } from "vitest";

import { schemaJson } from "../src/schema-json.ts";

it.each([
  { name: "exact-width", text: '{"struct":{"success":"bool"}}' },
  { name: "NUL-padded", text: '{"struct":{"success":"bool"}}\0\0' },
])("decodes $name schema bytes", ({ text }) => {
  expect(schemaJson(new TextEncoder().encode(text))).toBe('{"struct":{"success":"bool"}}');
});
