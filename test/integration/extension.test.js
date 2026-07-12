const assert = require("assert");
const vscode = require("vscode");

function findExtension() {
  return vscode.extensions.all.find(
    (e) => e.packageJSON && e.packageJSON.name === "claude-gauge"
  );
}

suite("Claude Usage integration", () => {
  test("the extension is present and activates", async () => {
    const ext = findExtension();
    assert.ok(ext, "extension not found");
    await ext.activate();
    assert.ok(ext.isActive, "extension did not activate");
  });

  test("registers its commands", async () => {
    const ext = findExtension();
    await ext.activate();
    const cmds = await vscode.commands.getCommands(true);
    for (const id of [
      "claudeUsage.refresh",
      "claudeUsage.pickSession",
      "claudeUsage.resumeChat",
      "claudeUsage.resumeSession",
      "claudeUsage.openBeside",
      "claudeUsage.open",
    ]) {
      assert.ok(cmds.includes(id), `missing command: ${id}`);
    }
  });

  test("refresh command runs without throwing", async () => {
    // It may hit the network/cache; we only assert it doesn't reject.
    await vscode.commands.executeCommand("claudeUsage.refresh");
  });
});
