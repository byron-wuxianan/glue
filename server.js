const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, 'glue.db');
const FRONTEND_DIR = __dirname; // 前端文件在同一目录

app.use(cors());
app.use(express.json());

// Serve static files (frontend)
app.use(express.static(FRONTEND_DIR));

// ==================== SQLite 初始化 ====================
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('DB open error:', err);
    else console.log('SQLite connected:', DB_PATH);
});

db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at INTEGER DEFAULT (strftime('%s','now'))
    )`);

    // 机型表
    db.run(`CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        positions TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
    )`);

    // 月产量表
    db.run(`CREATE TABLE IF NOT EXISTS monthly_production (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL,
        month TEXT NOT NULL,
        qty INTEGER DEFAULT 0,
        UNIQUE(model_id, month)
    )`);

    // 库存表
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        glue_model TEXT NOT NULL,
        glue_part_no TEXT NOT NULL,
        glue_desc TEXT,
        container_size REAL DEFAULT 0,
        production_date TEXT,
        expiry_date TEXT,
        shelf_life INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now')),
        UNIQUE(glue_model, glue_part_no)
    )`);

    // 月库存表
    db.run(`CREATE TABLE IF NOT EXISTS monthly_stock (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inventory_id INTEGER NOT NULL,
        month TEXT NOT NULL,
        stock INTEGER DEFAULT 0,
        UNIQUE(inventory_id, month)
    )`);

    // 胶水料号库表
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

    // 为 inventory 表增加 unit_capacity 字段（兼容旧表）
    db.run(`ALTER TABLE inventory ADD COLUMN unit_capacity REAL DEFAULT 0`, (err) => {
        // 忽略字段已存在的错误
    });

    // 初始化 admin
    const adminPass = bcrypt.hashSync('admin123', 10);
    db.get('SELECT id FROM users WHERE username = ?', ['admin'], (err, row) => {
        if (!row) {
            db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', adminPass, 'admin']);
            console.log('Default admin user created: admin / admin123');
        }
    });

    // 自动初始化种子数据（首次启动或数据为空时）
    seedInitialData();
});

// 从 database.js 自动导入初始数据
function seedInitialData() {
    const DB_JS_PATH = path.join(__dirname, 'database.js');
    if (!fs.existsSync(DB_JS_PATH)) {
        console.log('database.js not found, skip seeding');
        return;
    }
    db.get('SELECT COUNT(*) as cnt FROM models', [], (err, row) => {
        if (err) return console.error('Seed check error:', err);
        if (row && row.cnt > 0) {
            console.log('Models table already has data (' + row.cnt + ' rows), skip seeding');
            return;
        }
        console.log('Seeding initial data from database.js...');
        try {
            const jsContent = fs.readFileSync(DB_JS_PATH, 'utf8');
            const match = jsContent.match(/const GLUE_DATABASE = ({[\s\S]*});/);
            if (!match) { console.log('Could not parse database.js'); return; }
            const GLUE_DATABASE = (new Function('return ' + match[1]))();
            const currentMonth = new Date().toISOString().slice(0, 7);

            // 1. 导入机型 BOM
            const bomModels = GLUE_DATABASE.bomModels || {};
            const modelNameToId = {};
            const modelStmt = db.prepare('INSERT INTO models (name, positions) VALUES (?, ?)');
            for (const [modelName, modelData] of Object.entries(bomModels)) {
                const positions = (modelData.positions || []).map(p => ({
                    id: Date.now() + Math.random(),
                    name: p.name || '', glueModel: p.glueModel || '',
                    gluePartNo: p.gluePartNo || '', glueDesc: p.glueDesc || '',
                    perUnitUsage: p.perUnitUsage || 0, containerSize: p.containerSize || 0
                }));
                modelStmt.run([modelName, JSON.stringify(positions)], function() {
                    modelNameToId[modelName] = this.lastID;
                });
            }
            modelStmt.finalize();
            console.log('Seeded models: ' + Object.keys(bomModels).length);

            // 2. 导入月产量
            const productionPlan = GLUE_DATABASE.productionPlan || {};
            const prodStmt = db.prepare('INSERT OR REPLACE INTO monthly_production (model_id, month, qty) VALUES (?, ?, ?)');
            setTimeout(() => {
                for (const [modelName, qty] of Object.entries(productionPlan)) {
                    const modelId = modelNameToId[modelName];
                    if (modelId && qty) prodStmt.run([modelId, currentMonth, qty]);
                }
                prodStmt.finalize();
                console.log('Seeded production: ' + Object.keys(productionPlan).length);
            }, 500);

            // 3. 导入库存
            const inventoryObj = GLUE_DATABASE.inventory || {};
            const invStmt = db.prepare(`INSERT OR REPLACE INTO inventory (glue_model, glue_part_no, glue_desc, container_size, production_date, expiry_date, shelf_life) VALUES (?, ?, ?, ?, ?, ?, ?)`);
            const stockStmt = db.prepare('INSERT OR REPLACE INTO monthly_stock (inventory_id, month, stock) VALUES (?, ?, ?)');
            setTimeout(() => {
                for (const [key, inv] of Object.entries(inventoryObj)) {
                    invStmt.run([inv.glueModel || '', inv.gluePartNo || '', inv.glueDesc || '', inv.containerSize || 0,
                        inv.productionDate || '', inv.expiryDate || '', inv.shelfLife || 0], function() {
                        if (inv.stock !== undefined && inv.stock !== null) {
                            stockStmt.run([this.lastID, currentMonth, inv.stock]);
                        }
                    });
                }
                invStmt.finalize();
                stockStmt.finalize();
                console.log('Seeded inventory: ' + Object.keys(inventoryObj).length);
            }, 1000);

            // 4. 导入胶水料号库
            const glueCatalog = GLUE_DATABASE.glueCatalog || [];
            setTimeout(() => {
                const catStmt = db.prepare('INSERT OR IGNORE INTO glue_catalog (name, part_no, type, spec, container_size, unit_capacity) VALUES (?, ?, ?, ?, ?, ?)');
                glueCatalog.forEach(g => {
                    catStmt.run([g.name || '', g.partNo || '', g.type || '', g.spec || '', g.containerSize || 0, g.unitCapacity || 0]);
                });
                catStmt.finalize();
                console.log('Seeded glue catalog: ' + glueCatalog.length + ' items');
                console.log('Initial data seeding complete!');
            }, 1500);

        } catch (e) {
            console.error('Seed error:', e.message);
        }
    });
}

// ==================== 认证中间件 ====================
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: '未登录' });
    }
    const username = authHeader.substring(7);
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) return res.status(401).json({ error: '用户不存在' });
        req.user = user;
        next();
    });
}

// ==================== API: 认证 ====================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) return res.status(500).json({ error: '数据库错误' });
        if (!user) return res.status(401).json({ error: '用户名或密码错误' });
        if (!bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: '用户名或密码错误' });
        }
        res.json({ username: user.username, role: user.role });
    });
});

app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
    if (password.length < 4) return res.status(400).json({ error: '密码至少4个字符' });
    const hash = bcrypt.hashSync(password, 10);
    db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hash], function(err) {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' });
            return res.status(500).json({ error: '注册失败' });
        }
        res.json({ username, role: 'user' });
    });
});

app.get('/api/users', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
    db.all('SELECT id, username, role, created_at FROM users ORDER BY id', [], (err, rows) => {
        if (err) return res.status(500).json({ error: '查询失败' });
        res.json(rows);
    });
});

app.delete('/api/users/:username', authMiddleware, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
    const { username } = req.params;
    if (username === 'admin' || username === req.user.username) {
        return res.status(400).json({ error: '不能删除admin或当前用户' });
    }
    db.run('DELETE FROM users WHERE username = ?', [username], function(err) {
        if (err) return res.status(500).json({ error: '删除失败' });
        res.json({ success: true });
    });
});

// ==================== API: 机型 ====================
app.get('/api/models', authMiddleware, (req, res) => {
    db.all('SELECT * FROM models ORDER BY id', [], (err, rows) => {
        if (err) return res.status(500).json({ error: '查询失败' });
        const result = rows.map(r => ({
            id: r.id,
            name: r.name,
            positions: JSON.parse(r.positions || '[]'),
            qtyMap: {}
        }));
        const month = req.query.month || '';
        if (month) {
            db.all('SELECT model_id, qty FROM monthly_production WHERE month = ?', [month], (err2, prodRows) => {
                if (!err2) {
                    const qtyMap = {};
                    prodRows.forEach(r => { qtyMap[r.model_id] = r.qty; });
                    result.forEach(m => { m.qtyMap = { [month]: qtyMap[m.id] || 0 }; });
                }
                res.json(result);
            });
        } else {
            res.json(result);
        }
    });
});

app.post('/api/models', authMiddleware, (req, res) => {
    const { name, positions } = req.body;
    if (!name) return res.status(400).json({ error: '机型名称不能为空' });
    const posJson = JSON.stringify(positions || []);
    db.run('INSERT INTO models (name, positions) VALUES (?, ?)', [name, posJson], function(err) {
        if (err) return res.status(500).json({ error: '创建失败' });
        res.json({ id: this.lastID, name, positions: positions || [] });
    });
});

app.put('/api/models/:id', authMiddleware, (req, res) => {
    const { name, positions } = req.body;
    const posJson = JSON.stringify(positions || []);
    db.run('UPDATE models SET name = ?, positions = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?',
        [name, posJson, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: '更新失败' });
            res.json({ success: true });
        });
});

app.delete('/api/models/:id', authMiddleware, (req, res) => {
    db.serialize(() => {
        db.run('DELETE FROM monthly_production WHERE model_id = ?', [req.params.id]);
        db.run('DELETE FROM models WHERE id = ?', [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: '删除失败' });
            res.json({ success: true });
        });
    });
});

// ==================== API: 月产量 ====================
app.put('/api/production', authMiddleware, (req, res) => {
    const { modelId, month, qty } = req.body;
    if (!modelId || !month) return res.status(400).json({ error: '参数不完整' });
    db.run(`INSERT INTO monthly_production (model_id, month, qty) VALUES (?, ?, ?)
            ON CONFLICT(model_id, month) DO UPDATE SET qty = excluded.qty`,
        [modelId, month, qty || 0], function(err) {
            if (err) return res.status(500).json({ error: '保存失败' });
            res.json({ success: true });
        });
});

// ==================== API: 库存 ====================
app.get('/api/inventory', authMiddleware, (req, res) => {
    db.all('SELECT * FROM inventory ORDER BY id', [], (err, rows) => {
        if (err) return res.status(500).json({ error: '查询失败' });
        const result = rows.map(r => ({
            id: r.id,
            glue_model: r.glue_model,
            glue_part_no: r.glue_part_no,
            glue_desc: r.glue_desc,
            container_size: r.container_size,
            unit_capacity: r.unit_capacity || 0,
            production_date: r.production_date,
            expiry_date: r.expiry_date,
            shelf_life: r.shelf_life,
            stockMap: {}
        }));
        const month = req.query.month || '';
        if (month) {
            db.all('SELECT inventory_id, stock FROM monthly_stock WHERE month = ?', [month], (err2, stockRows) => {
                if (!err2) {
                    const stockMap = {};
                    stockRows.forEach(r => { stockMap[r.inventory_id] = r.stock; });
                    result.forEach(inv => { inv.stockMap = { [month]: stockMap[inv.id] || 0 }; });
                }
                res.json(result);
            });
        } else {
            res.json(result);
        }
    });
});

app.post('/api/inventory', authMiddleware, (req, res) => {
    const { glueModel, gluePartNo, glueDesc, containerSize, unitCapacity } = req.body;
    db.run(`INSERT INTO inventory (glue_model, glue_part_no, glue_desc, container_size, unit_capacity)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(glue_model, glue_part_no) DO UPDATE SET
            glue_desc = excluded.glue_desc, container_size = excluded.container_size,
            unit_capacity = excluded.unit_capacity`,
        [glueModel, gluePartNo, glueDesc, containerSize || 0, unitCapacity || 0], function(err) {
            if (err) return res.status(500).json({ error: '保存失败' });
            res.json({ success: true, id: this.lastID || true });
        });
});

app.put('/api/inventory/:id', authMiddleware, (req, res) => {
    const { glueModel, gluePartNo, glueDesc, containerSize, unitCapacity } = req.body;
    db.run(`UPDATE inventory SET glue_model = ?, glue_part_no = ?, glue_desc = ?, container_size = ?, unit_capacity = ?, updated_at = strftime('%s','now')
            WHERE id = ?`,
        [glueModel, gluePartNo, glueDesc, containerSize || 0, unitCapacity || 0, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: '更新失败' });
            res.json({ success: true });
        });
});

app.delete('/api/inventory/:id', authMiddleware, (req, res) => {
    db.serialize(() => {
        db.run('DELETE FROM monthly_stock WHERE inventory_id = ?', [req.params.id]);
        db.run('DELETE FROM inventory WHERE id = ?', [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: '删除失败' });
            res.json({ success: true });
        });
    });
});

// ==================== API: 月库存 ====================
app.put('/api/stock', authMiddleware, (req, res) => {
    const { inventoryId, month, stock } = req.body;
    if (!inventoryId || !month) return res.status(400).json({ error: '参数不完整' });
    db.run(`INSERT INTO monthly_stock (inventory_id, month, stock) VALUES (?, ?, ?)
            ON CONFLICT(inventory_id, month) DO UPDATE SET stock = excluded.stock`,
        [inventoryId, month, stock || 0], function(err) {
            if (err) return res.status(500).json({ error: '保存失败' });
            res.json({ success: true });
        });
});

// ==================== API: 胶水料号库 ====================
app.get('/api/glue-catalog', authMiddleware, (req, res) => {
    db.all('SELECT * FROM glue_catalog ORDER BY id', [], (err, rows) => {
        if (err) return res.status(500).json({ error: '查询失败' });
        const result = rows.map(r => ({
            id: r.id,
            name: r.name,
            partNo: r.part_no,
            type: r.type || '',
            spec: r.spec || '',
            containerSize: r.container_size || 0,
            unitCapacity: r.unit_capacity || 0
        }));
        res.json(result);
    });
});

app.post('/api/glue-catalog', authMiddleware, (req, res) => {
    const { name, partNo, type, spec, containerSize, unitCapacity } = req.body;
    if (!name) return res.status(400).json({ error: '胶水型号不能为空' });
    db.run(`INSERT INTO glue_catalog (name, part_no, type, spec, container_size, unit_capacity)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(name, part_no) DO UPDATE SET
            type = excluded.type, spec = excluded.spec,
            container_size = excluded.container_size,
            unit_capacity = excluded.unit_capacity,
            updated_at = strftime('%s','now')`,
        [name, partNo || '', type || '', spec || '', containerSize || 0, unitCapacity || 0], function(err) {
            if (err) return res.status(500).json({ error: '保存失败' });
            res.json({ success: true, id: this.lastID });
        });
});

app.put('/api/glue-catalog/:id', authMiddleware, (req, res) => {
    const { name, partNo, type, spec, containerSize, unitCapacity } = req.body;
    db.run(`UPDATE glue_catalog SET name = ?, part_no = ?, type = ?, spec = ?,
            container_size = ?, unit_capacity = ?, updated_at = strftime('%s','now')
            WHERE id = ?`,
        [name, partNo || '', type || '', spec || '', containerSize || 0, unitCapacity || 0, req.params.id], function(err) {
            if (err) return res.status(500).json({ error: '更新失败' });
            res.json({ success: true });
        });
});

app.delete('/api/glue-catalog/:id', authMiddleware, (req, res) => {
    db.run('DELETE FROM glue_catalog WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: '删除失败' });
        res.json({ success: true });
    });
});

// 批量导入胶水料号库（初始化用）
app.post('/api/glue-catalog/batch', authMiddleware, (req, res) => {
    const items = req.body.items || [];
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: '数据不能为空' });
    }
    db.serialize(() => {
        const stmt = db.prepare(`INSERT OR IGNORE INTO glue_catalog (name, part_no, type, spec, container_size, unit_capacity)
            VALUES (?, ?, ?, ?, ?, ?)`);
        let count = 0;
        items.forEach(item => {
            stmt.run([item.name, item.partNo || '', item.type || '', item.spec || '',
                item.containerSize || 0, item.unitCapacity || 0], function() {
                if (this.changes > 0) count++;
            });
        });
        stmt.finalize(() => {
            res.json({ success: true, imported: count, total: items.length });
        });
    });
});

// ==================== 健康检查 ====================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: Date.now() });
});

// SPA fallback: serve index.html for all non-API routes
app.get('*', (req, res) => {
    const indexPath = path.join(FRONTEND_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('index.html not found');
    }
});

// 启动
app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('  胶水采购需求管理系统 - 后端服务');
    console.log('  端口: ' + PORT);
    console.log('  数据库: ' + DB_PATH);
    console.log('  前端目录: ' + FRONTEND_DIR);
    console.log('========================================');
});
