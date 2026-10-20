import assert from "node:assert/strict";
import test from "node:test";

import { buildInvookSkill, MCP_SERVER_INSTRUCTIONS } from "./mcp-instructions";

const serverUrl = "https://invook.example/mcp";

test("the skill is a valid Agent Skill whose name matches its install folder", () => {
  const skill = buildInvookSkill(serverUrl);
  const frontmatter = /^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/.exec(skill);

  assert.ok(frontmatter, "the skill starts with name and description frontmatter");
  assert.equal(frontmatter[1], "invook");
  assert.ok((frontmatter[2]?.length ?? 0) <= 1_024);
  assert.match(skill, /~\/\.claude\/skills\/invook\/SKILL\.md/);
  assert.match(skill, /~\/\.agents\/skills\/invook\/SKILL\.md/);
});

test("the skill connects every documented agent to this installation's server", () => {
  const skill = buildInvookSkill(serverUrl);

  assert.ok(
    skill.includes(`claude mcp add --transport http --scope user invook ${serverUrl}`),
  );
  assert.ok(skill.includes(`codex mcp add invook --url ${serverUrl}`));
  assert.ok(skill.includes(`"invook": { "url": "${serverUrl}" }`));
});

test("agents that only connect the server get the same working rules as the skill", () => {
  const skill = buildInvookSkill(serverUrl);
  const rules = MCP_SERVER_INSTRUCTIONS.split("\n").filter((line) => line.startsWith("- "));

  assert.ok(rules.length > 0);
  for (const rule of rules) assert.ok(skill.includes(rule), rule);
  assert.match(MCP_SERVER_INSTRUCTIONS, /untrusted data/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /only when the user explicitly asks you to send/);
});
