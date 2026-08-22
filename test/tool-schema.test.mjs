import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadFallbackDefineTool() {
	const source = fs.readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	const match = source.match(/function fallbackDefineTool\(options\) \{([\s\S]*?)\n\}/);
	assert.ok(match, "lib/index.js must define fallbackDefineTool(options)");
	return vm.runInNewContext(`(function fallbackDefineTool(options) {${match[1]}\n})`);
}

test("fallback tool definition emits an object JSON Schema", () => {
	const fallbackDefineTool = loadFallbackDefineTool();
	const tool = fallbackDefineTool({
		name: "rss_daily",
		parameters: {
			action: { type: "string", required: false, description: "run | status" },
		},
	});

	assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", description: "run | status" },
		},
	});
});
