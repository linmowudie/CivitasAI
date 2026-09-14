// 诊断：查看某会话最近消息
const db = require('better-sqlite3')('Data/db/civitas_main.db', { readonly: true });
const sid = process.argv[2] || 'sess-24c779f3';
const rows = db.prepare(
  'SELECT message_id, role, substr(content,1,80) AS preview, length(content) AS len, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 5'
).all(sid);
const now = Date.now();
for (const r of rows) {
  console.log(`${r.message_id} [${r.role}] len=${r.len} age=${Math.round((now - r.created_at) / 1000)}s`);
  console.log('   ' + JSON.stringify(r.preview));
}
