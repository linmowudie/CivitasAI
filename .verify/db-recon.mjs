import Database from "better-sqlite3";
const main = new Database("Data/db/civitas_main.db", { readonly: true });
const ev = new Database("Data/db/civitas_events.db", { readonly: true });
const q = (db, sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ err: String(e.message).slice(0, 60) }]; } };
console.log("main 库行数：");
for (const t of ["long_term_memory","chat_messages","chat_sessions","token_transactions","token_wallets","effect_journal","global_workspace","loops"]) {
  const r = q(main, `SELECT COUNT(*) AS n FROM ${t}`);
  console.log(`  ${t.padEnd(20)} ${r[0]?.n ?? r[0]?.err}`);
}
console.log("events 库行数：");
for (const t of ["events","domain_events"]) {
  const r = q(ev, `SELECT COUNT(*) AS n FROM ${t}`);
  console.log(`  ${t.padEnd(20)} ${r[0]?.n ?? r[0]?.err}`);
}
console.log("\ndomain_events 事件类型 TOP8：");
for (const r of q(ev, `SELECT event_type, COUNT(*) n FROM domain_events GROUP BY 1 ORDER BY n DESC LIMIT 8`)) console.log(`  ${r.event_type} = ${r.n}`);
console.log("\ntoken_transactions 列：", q(main, "PRAGMA table_info(token_transactions)").map(c => c.name).join(", "));
console.log("chat_messages 角色分布：");
for (const r of q(main, `SELECT role, COUNT(*) n FROM chat_messages GROUP BY 1`)) console.log(`  ${r.role} = ${r.n}`);
main.close(); ev.close();
