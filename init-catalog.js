// Initialize glue catalog from database.js into SQLite
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const GLUE_DATABASE = require('./database.js');

const DB_PATH = path.join(__dirname, 'glue.db');

if (!GLUE_DATABASE || !GLUE_DATABASE.glueCatalog) {
    console.error('Failed to load GLUE_DATABASE.glueCatalog from database.js');
    process.exit(1);
}

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS glue_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        part_no TEXT NOT NULL,
        type TEXT DEFAULT '',
        spec TEXT DEFAULT '',
        container_size REAL DEFAULT 0,
        unit_capacity REAL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now')),
        UNIQUE(name, part_no)
    )`);

    const stmt = db.prepare(`INSERT OR IGNORE INTO glue_catalog (name, part_no, type, spec, container_size, unit_capacity) VALUES (?, ?, ?, ?, ?, ?)`);

    let count = 0;
    const catalog = GLUE_DATABASE.glueCatalog;
    catalog.forEach(item => {
        stmt.run([item.name, item.partNo || '', item.type || '', item.spec || '', item.containerSize || 0, item.unitCapacity || 0], function() {
            if (this.changes > 0) count++;
        });
    });

    stmt.finalize(() => {
        console.log('Imported ' + count + ' glue catalog entries (total in file: ' + catalog.length + ')');
        db.close();
    });
});
