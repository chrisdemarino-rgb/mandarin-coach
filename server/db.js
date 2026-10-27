// SQLite store: prefs, saved words, minimal word history. NO recordings/transcripts/conversations.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saved_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL UNIQUE,
  pinyin TEXT, meaning TEXT, source_chunk TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS word_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word_id INTEGER NOT NULL REFERENCES saved_words(id) ON DELETE CASCADE,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  result TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_word ON word_history(word_id, ts);
`;

export const PREF_DEFAULTS = Object.freeze({
  chunkMode: 'sentence',      // sentence | four | paragraph
  assessMode: 'close',        // close | retell
  practiceMode: 'listen_repeat', // free-form id from the frontend (listen_repeat | fading_cues | ...)
  voice: 'zh-CN-XiaoxiaoNeural',
  speed: 1.0,                 // 0.6 - 1.2
});

export function openDb(dataDir) {
  const file = dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'coach.db');
  if (file !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(file);
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const q = {
    allPrefs: db.prepare('SELECT key, value FROM prefs'),
    setPref: db.prepare('INSERT INTO prefs(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
    listWords: db.prepare(`SELECT w.id, w.text, w.pinyin, w.meaning, w.source_chunk AS sourceChunk, w.created_at AS createdAt,
        (SELECT COUNT(*) FROM word_history h WHERE h.word_id=w.id) AS attempts,
        (SELECT result FROM word_history h WHERE h.word_id=w.id ORDER BY h.id DESC LIMIT 1) AS lastResult
      FROM saved_words w ORDER BY w.id DESC`),
    getWord: db.prepare('SELECT id, text, pinyin, meaning, source_chunk AS sourceChunk, created_at AS createdAt FROM saved_words WHERE id=?'),
    byText: db.prepare('SELECT id FROM saved_words WHERE text=?'),
    insWord: db.prepare('INSERT INTO saved_words(text,pinyin,meaning,source_chunk) VALUES(?,?,?,?)'),
    delWord: db.prepare('DELETE FROM saved_words WHERE id=?'),
    insHist: db.prepare('INSERT INTO word_history(word_id,result) VALUES(?,?)'),
    history: db.prepare('SELECT ts, result FROM word_history WHERE word_id=? ORDER BY id DESC LIMIT 50'),
  };

  return {
    raw: db,
    close: () => db.close(),
    getPrefs() {
      const out = { ...PREF_DEFAULTS };
      for (const { key, value } of q.allPrefs.all()) {
        try { out[key] = JSON.parse(value); } catch { /* skip corrupt */ }
      }
      return out;
    },
    setPrefs(patch) {
      const tx = db.transaction((p) => { for (const [k, v] of Object.entries(p)) q.setPref.run(k, JSON.stringify(v)); });
      tx(patch);
    },
    listWords: () => q.listWords.all(),
    getWord: (id) => q.getWord.get(id) ?? null,
    addWord({ text, pinyin, meaning, sourceChunk }) {
      const existing = q.byText.get(text);
      if (existing) return { id: existing.id, created: false };
      const info = q.insWord.run(text, pinyin ?? null, meaning ?? null, sourceChunk ?? null);
      return { id: Number(info.lastInsertRowid), created: true };
    },
    deleteWord: (id) => q.delWord.run(id).changes > 0,
    addHistory(wordId, result) { q.insHist.run(wordId, result); },
    wordHistory: (id) => q.history.all(id),
  };
}
