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

    // 初始化 admin
    const adminPass = bcrypt.hashSync('admin123', 10);
    db.get('SELECT id FROM users WHERE username = ?', ['admin'], (err, row) => {
        if (!row) {
            db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', ['admin', adminPass, 'admin']);
            console.log('Default admin user created: admin / admin123');
        }
    });
});

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
    const { glueModel, gluePartNo, glueDesc, containerSize } = req.body;
    db.run(`INSERT INTO inventory (glue_model, glue_part_no, glue_desc, container_size)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(glue_model, glue_part_no) DO UPDATE SET
            glue_desc = excluded.glue_desc, container_size = excluded.container_size`,
        [glueModel, gluePartNo, glueDesc, containerSize || 0], function(err) {
            if (err) return res.status(500).json({ error: '保存失败' });
            res.json({ success: true, id: this.lastID || true });
        });
});

app.put('/api/inventory/:id', authMiddleware, (req, res) => {
    const { glueModel, gluePartNo, glueDesc, containerSize } = req.body;
    db.run(`UPDATE inventory SET glue_model = ?, glue_part_no = ?, glue_desc = ?, container_size = ?, updated_at = strftime('%s','now')
            WHERE id = ?`,
        [glueModel, gluePartNo, glueDesc, containerSize || 0, req.params.id], function(err) {
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
