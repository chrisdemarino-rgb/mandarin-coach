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
-- Rolling "words I don't know" list (additive migration: new table only; saved_words is untouched).
-- Holds ONLY: the word (a span of the user's own script), its pinyin, a short gloss, counters, status. NO audio, NO transcripts.
CREATE TABLE IF NOT EXISTS missed_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL UNIQUE,
  pinyin TEXT, meaning TEXT, source_chunk TEXT,
  miss_count INTEGER NOT NULL DEFAULT 1,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'learning' CHECK (status IN ('learning','known')),
  gloss_tried INTEGER NOT NULL DEFAULT 0,
  last_missed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_missed_status ON missed_words(status, miss_count, last_missed_at);
`;

export const PREF_DEFAULTS = Object.freeze({
  chunkMode: 'sentence',      // sentence | four | paragraph
  assessMode: 'close',        // close | retell
  practiceMode: 'listen_repeat', // listen_repeat | fading_cues | trouble_word (see routes/prefs.js)
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

  const MW = 'id, text, pinyin, meaning, miss_count AS missCount, correct_streak AS correctStreak, last_missed_at AS lastMissedAt, source_chunk AS sourceChunk, status, gloss_tried AS glossTried';
  const m = {
    list: db.prepare(`SELECT ${MW} FROM missed_words WHERE status='learning' ORDER BY miss_count DESC, last_missed_at DESC, id DESC`),
    listAll: db.prepare(`SELECT ${MW} FROM missed_words ORDER BY (status='learning') DESC, miss_count DESC, last_missed_at DESC, id DESC`),
    get: db.prepare(`SELECT ${MW} FROM missed_words WHERE id=?`),
    byText: db.prepare(`SELECT ${MW} FROM missed_words WHERE text=?`),
    ins: db.prepare('INSERT INTO missed_words(text,pinyin,meaning,source_chunk) VALUES(?,?,?,?)'),
    // a miss: count it, reset the streak, bring a "known" word back to learning
    miss: db.prepare(`UPDATE missed_words SET miss_count=miss_count+1, correct_streak=0, status='learning', last_missed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), source_chunk=COALESCE(?, source_chunk), pinyin=COALESCE(pinyin, ?) WHERE id=?`),
    setStatus: db.prepare('UPDATE missed_words SET status=?, correct_streak=0 WHERE id=?'),
    setStreak: db.prepare('UPDATE missed_words SET correct_streak=?, status=? WHERE id=?'),
    setMeaning: db.prepare('UPDATE missed_words SET meaning=?, gloss_tried=1 WHERE id=?'),
    glossTried: db.prepare('UPDATE missed_words SET gloss_tried=1 WHERE id=?'),
    del: db.prepare('DELETE FROM missed_words WHERE id=?'),
    next: db.prepare(`SELECT ${MW} FROM missed_words WHERE status='learning' ORDER BY correct_streak ASC, miss_count DESC, last_missed_at DESC, id DESC LIMIT ?`),
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

    // ---- missed words ("words I don't know")
    listMissed: (all = false) => (all ? m.listAll : m.list).all(),
    getMissed: (id) => m.get.get(id) ?? null,
    getMissedByText: (text) => m.byText.get(text) ?? null,
    /** Record a miss. Dedupes by text. -> { id, created, word } */
    recordMiss({ text, pinyin, meaning, sourceChunk }) {
      const tx = db.transaction(() => {
        const ex = m.byText.get(text);
        if (ex) { m.miss.run(sourceChunk ?? null, pinyin ?? null, ex.id); return { id: ex.id, created: false }; }
        const info = m.ins.run(text, pinyin ?? null, meaning ?? null, sourceChunk ?? null);
        return { id: Number(info.lastInsertRowid), created: true };
      });
      const r = tx();
      return { ...r, word: m.get.get(r.id) };
    },
    setMissedStatus(id, status) { return m.setStatus.run(status, id).changes > 0; },
    deleteMissed: (id) => m.del.run(id).changes > 0,
    setMissedMeaning: (id, meaning) => m.setMeaning.run(meaning, id),
    markGlossTried: (id) => m.glossTried.run(id),
    drillQueue: (n) => m.next.all(Math.max(1, Math.min(20, n | 0))),
    /** A drill result decided by the server. correct -> streak+1 (graduates at `needed`); incorrect -> streak 0, miss counted. */
    recordDrill(id, correct, needed) {
      const tx = db.transaction(() => {
        const w = m.get.get(id); if (!w) return null;
        if (correct) {
          const streak = w.correctStreak + 1; const graduated = streak >= needed;
          m.setStreak.run(streak, graduated ? 'known' : 'learning', id);
        } else m.miss.run(null, null, id);
        const after = m.get.get(id);
        return { word: after, graduated: correct && after.status === 'known' };
      });
      return tx();
    },
  };
}
