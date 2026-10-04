import { initDatabase, closeDatabase } from "../Src/Infra/Db/database.js";
import { initMigrations, clearMigrations, migrateUp } from "../Src/Infra/Db/migrations.js";
import { createApproval } from "../Src/Services/LoopControl/approvalGate.js";
import { rmSync, mkdirSync } from "node:fs";
const dir = "Data/_probe_approval";
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
initDatabase({ mainPath: dir + "/m.db", eventsPath: dir + "/e.db", memoryPath: dir + "/mm.db", walMode: true, busyTimeoutMs: 5000 });
initMigrations(); migrateUp();
const r = createApproval({
  loopId: "loop-1", traceId: "trace-1", iteration: 1, requestedBy: "agent-1",
  kind: "irreversible_action", payload: { tool: "x" }, riskLevel: "CRITICAL",
  deciders: [{ role: "user", weight: 1 }, { role: "prime_director", weight: 1 }],
});
console.log("ok:", r.ok, "| error:", r.ok ? "-" : r.error);
if (r.ok) console.log("approvalId:", r.value.approvalId, "| policy:", r.value.decisionPolicy, "| deciders:", JSON.stringify(r.value.deciders));
closeDatabase(); rmSync(dir, { recursive: true, force: true });
