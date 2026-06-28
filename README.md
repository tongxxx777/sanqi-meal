# 叁柒食 - 情侣小厨房

一个为情侣设计的微信小程序，帮助两个人一起管理菜品、记录饮食生活。

## ✨ 功能概览

### 👫 伴侣绑定
- 通过邀请码配对，数据自动双向同步
- 绑定详情页展示双方信息、厨房名称
- 支持解除绑定（双方实时同步）

### 🍳 菜品库管理
- 添加/编辑菜品，支持名称、分类、图片、描述
- **图片搜索**：输入菜名自动搜索美食图片，一键选用
- 自定义菜品分类（荤菜/素菜/汤品/主食等），支持排序
- 分类管理支持新增、编辑、删除、拖拽排序

### 📋 每日点菜
- 从菜品库选菜下单，支持备注
- 伴侣实时收到微信订阅消息通知
- 点菜页按分类展示菜品，支持快捷加菜

### 📖 历史记录
- 查看所有点菜历史，按时间展示
- 支持"再来一单"快速复用
- 订单详情页展示完整点菜信息

### ⚙️ 个人设置
- 自定义厨房名称，双方同步显示
- 订阅消息管理
- 用户昵称/头像展示

---

## 🛠 技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| 前端 | 微信小程序原生 | WXML + WXSS + JS |
| UI | WeUI | 微信官方组件库 |
| 后端 | 微信云函数 | Node.js + wx-server-sdk |
| 数据库 | 微信云数据库 | NoSQL 文档数据库 |
| 存储 | 微信云存储 | 菜品图片存储 |
| 通知 | 微信订阅消息 | 点菜/新菜品通知 |
| 图片搜索 | 百度图片搜索 | 无需 API Key，直接爬取 |

---

## 📁 项目结构

```
├── cloudfunctions/                  # 云函数
│   ├── createUser/                  # 用户注册/登录，生成邀请码
│   ├── bindPartner/                 # 伴侣配对绑定
│   ├── unbindPartner/               # 解除绑定
│   ├── getInviterInfo/              # 获取邀请人信息
│   ├── getCoupleData/               # 查询伴侣共享数据
│   ├── updateCoupleData/            # 更新/删除共享数据
│   ├── manageCategory/              # 分类管理
│   ├── updateKitchenName/           # 更新厨房名称
│   ├── sendNotify/                  # 发送订阅消息通知
│   ├── getOpenId/                   # 获取用户 OpenID
│   ├── getFileURL/                  # 图片临时链接转换
│   └── generateAIImage/             # 图片搜索
├── miniprogram/                     # 小程序前端
│   ├── app.js                       # 全局逻辑
│   ├── app.json                     # 页面路由与 TabBar 配置
│   ├── app.wxss                     # 全局样式
│   ├── envList.js                   # 云环境配置
│   ├── components/
│   │   └── bind-guard/              # 绑定状态提醒组件
│   └── pages/
│       ├── index/                   # 首页
│       ├── order/                   # 点菜页
│       ├── dishes/                  # 菜品库浏览
│       ├── dish-add/                # 添加/编辑菜品
│       ├── dish-detail/             # 菜品详情
│       ├── order-history/           # 历史记录
│       ├── order-detail/            # 订单详情
│       ├── bind/                    # 伴侣绑定
│       ├── bind-confirm/            # 绑定确认页
│       ├── settings/                # 个人设置
│       └── category-manage/         # 分类管理
├── project.config.json              # 微信开发者工具配置
├── project.private.config.json      # 个人本地配置
└── README.md
```

---

## ☁️ 云函数列表

| 云函数 | 功能 |
|--------|------|
| `createUser` | 用户注册/登录 |
| `bindPartner` | 伴侣绑定 |
| `unbindPartner` | 解除绑定 |
| `getInviterInfo` | 获取邀请人信息 |
| `getCoupleData` | 查询共享数据 |
| `updateCoupleData` | 更新共享数据 |
| `manageCategory` | 分类管理 |
| `updateKitchenName` | 厨房命名 |
| `sendNotify` | 消息通知 |
| `getOpenId` | 获取 OpenID |
| `getFileURL` | 图片临时链接 |
| `generateAIImage` | 图片搜索 |

---

## 🗄 数据库集合

| 集合 | 用途 | 数据隔离 |
|------|------|---------|
| `User` | 用户信息、绑定关系 | `openid` |
| `DishList` | 菜品库 | `coupleId` |
| `OrderList` | 点菜记录 | `coupleId` |
| `Category` | 菜品分类 | `coupleId` |

---