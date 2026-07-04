// init-db.js - 从 database.js 初始化 SQLite 数据库
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');

const DB_PATH = path.join(__dirname, 'glue.db');
const DB_JS_PATH = path.join(__dirname, 'database.js');

// 读取并解析 database.js
const jsContent = fs.readFileSync(DB_JS_PATH, 'utf8');
const match = jsContent.match(/const GLUE_DATABASE = ({[\s\S]*});/);
if (!match) { console.error('无法解析 database.js'); process.exit(1); }
const GLUE_DATABASE = (new Function('return ' + match[1]))();

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) { console.error('DB error:', err); process.exit(1); }
});

// Promisify db.run and db.get
const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { err ? reject(err) : resolve(row); });
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { err ? reject(err) : resolve(rows); });
});

async function main() {
    try {
        // 清空现有数据
        await run('DELETE FROM monthly_stock');
        await run('DELETE FROM monthly_production');
        await run('DELETE FROM inventory');
        await run('DELETE FROM models');
        console.log('已清空旧数据');

        const currentMonth = new Date().toISOString().slice(0, 7);

        // 1. 导入机型 BOM
        const bomModels = GLUE_DATABASE.bomModels || {};
        const modelNameToId = {};
        for (const [modelName, modelData] of Object.entries(bomModels)) {
            const positions = (modelData.positions || []).map(p => ({
                id: Date.now() + Math.random(),
                name: p.name || '',
                glueModel: p.glueModel || '',
                gluePartNo: p.gluePartNo || '',
                glueDesc: p.glueDesc || '',
                perUnitUsage: p.perUnitUsage || 0,
                containerSize: p.containerSize || 0
            }));
            const result = await run('INSERT INTO models (name, positions) VALUES (?, ?)',
                [modelName, JSON.stringify(positions)]);
            modelNameToId[modelName] = result.lastID;
        }
        console.log(`机型 BOM: ${Object.keys(bomModels).length} 个`);

        // 2. 导入月产量
        const productionPlan = GLUE_DATABASE.productionPlan || {};
        let prodCount = 0;
        for (const [modelName, qty] of Object.entries(productionPlan)) {
            const modelId = modelNameToId[modelName];
            if (modelId && qty) {
                await run('INSERT OR REPLACE INTO monthly_production (model_id, month, qty) VALUES (?, ?, ?)',
                    [modelId, currentMonth, qty]);
                prodCount++;
            }
        }
        console.log(`月产量(${currentMonth}): ${prodCount} 条`);

        // 3. 导入库存
        const inventoryObj = GLUE_DATABASE.inventory || {};
        const inventoryIdMap = {};
        let invCount = 0;
        for (const [key, inv] of Object.entries(inventoryObj)) {
            const result = await run(`INSERT OR REPLACE INTO inventory
                (glue_model, glue_part_no, glue_desc, container_size, production_date, expiry_date, shelf_life)
                VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                inv.glueModel || '',
                inv.gluePartNo || '',
                inv.glueDesc || '',
                inv.containerSize || 0,
                inv.productionDate || '',
                inv.expiryDate || '',
                inv.shelfLife || 0
            ]);
            inventoryIdMap[key] = result.lastID;
            invCount++;
        }
        console.log(`库存: ${invCount} 条`);

        // 4. 导入当月库存
        let stockCount = 0;
        for (const [key, inv] of Object.entries(inventoryObj)) {
            const stock = inv.stock;
            if (stock !== undefined && stock !== null) {
                const invId = inventoryIdMap[key];
                if (invId) {
                    await run('INSERT OR REPLACE INTO monthly_stock (inventory_id, month, stock) VALUES (?, ?, ?)',
                        [invId, currentMonth, stock]);
                    stockCount++;
                }
            }
        }
        console.log(`月库存(${currentMonth}): ${stockCount} 条`);

        console.log('初始化完成！');
    } catch (err) {
        console.error('初始化失败:', err);
    } finally {
        db.close();
    }
}

main();
