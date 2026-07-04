// ==================== API 配置 ====================
const API_BASE = '/api';  // 同源代理，由后端服务静态文件

// ==================== AUTH & PERSISTENCE ====================
let currentUser = null;
let authToken = '';  // username for Bearer token (simplified)

// 登录
async function apiLogin(username, password) {
    const res = await fetch(API_BASE + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    return res.json();
}

// 注册
async function apiRegister(username, password) {
    const res = await fetch(API_BASE + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    return res.json();
}

// 通用 API 请求
async function apiRequest(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;

    const res = await fetch(API_BASE + url, { ...options, headers });
    if (res.status === 401) {
        doLogout();
        throw new Error('会话已过期，请重新登录');
    }
    return res.json();
}

// ==================== 数据操作 API ====================

// 加载机型
async function apiLoadModels(month) {
    return apiRequest('/models?month=' + (month || ''));
}

// 保存机型（新增/更新）
async function apiSaveModel(model) {
    if (model.id && model.id > 0) {
        return apiRequest('/models/' + model.id, {
            method: 'PUT',
            body: JSON.stringify({ name: model.name, positions: model.positions })
        });
    } else {
        return apiRequest('/models', {
            method: 'POST',
            body: JSON.stringify({ name: model.name, positions: model.positions })
        });
    }
}

// 删除机型
async function apiDeleteModel(id) {
    return apiRequest('/models/' + id, { method: 'DELETE' });
}

// 保存月产量
async function apiSaveProduction(modelId, month, qty) {
    return apiRequest('/production', {
        method: 'PUT',
        body: JSON.stringify({ modelId, month, qty })
    });
}

// 加载库存
async function apiLoadInventory(month) {
    return apiRequest('/inventory?month=' + (month || ''));
}

// 保存库存项
async function apiSaveInventory(inv) {
    if (inv.id && inv.id > 0) {
        return apiRequest('/inventory/' + inv.id, {
            method: 'PUT',
            body: JSON.stringify({
                glueModel: inv.glueModel, gluePartNo: inv.gluePartNo,
                glueDesc: inv.glueDesc, containerSize: inv.containerSize
            })
        });
    } else {
        return apiRequest('/inventory', {
            method: 'POST',
            body: JSON.stringify({
                glueModel: inv.glueModel, gluePartNo: inv.gluePartNo,
                glueDesc: inv.glueDesc, containerSize: inv.containerSize
            })
        });
    }
}

// 保存月库存
async function apiSaveStock(inventoryId, month, stock) {
    return apiRequest('/stock', {
        method: 'PUT',
        body: JSON.stringify({ inventoryId, month, stock })
    });
}

// 删除库存项
async function apiDeleteInventory(id) {
    return apiRequest('/inventory/' + id, { method: 'DELETE' });
}

// 用户管理
async function apiGetUsers() {
    return apiRequest('/users');
}

async function apiDeleteUser(username) {
    return apiRequest('/users/' + encodeURIComponent(username), { method: 'DELETE' });
}
