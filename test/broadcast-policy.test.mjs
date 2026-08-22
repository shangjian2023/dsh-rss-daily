import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function loadFunction(name) {
	const source = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	const match = source.match(new RegExp(`function ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n\\t\\t\\}`));
	assert.ok(match, `client.js must define ${name}()`);
	return vm.runInNewContext(`(function ${name}(${match[1]}) {${match[2]}\n})`);
}

function element(attrs = {}, childElementCount = 0) {
	return {
		childElementCount,
		getAttribute(name) { return attrs[name] ?? null; },
	};
}

test("broadcast stays hidden on a blank new conversation", () => {
	const conversationHasContent = loadFunction("conversationHasContent");
	const scroller = {
		children: [
			element({ "data-slot": "conversation.session" }, 0),
			element({ "data-composer-seat": "" }, 8),
		],
	};

	assert.equal(conversationHasContent(scroller), false);
});

test("broadcast remains available in a populated conversation", () => {
	const conversationHasContent = loadFunction("conversationHasContent");
	const scroller = {
		children: [
			element({ "data-slot": "conversation.session" }, 3),
			element({ "data-composer-seat": "" }, 8),
		],
	};

	assert.equal(conversationHasContent(scroller), true);
});
