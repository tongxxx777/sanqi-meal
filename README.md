# 叁柒食 - 情侣小厨房

一个为情侣设计的微信小程序,帮助两个人一起管理菜品,每日点菜,记录饮食生活.

## 功能概览

- **伴侣绑定**：通过邀请码配对,数据自动双向同步
- **菜品库管理**：添加/编辑菜品,支持分类、图片、描述
- **每日点菜**：从菜品库选菜下单,支持备注,伴侣实时收到通知
- **历史记录**：查看所有点菜历史,支持"再来一单"快速复用
- **分类管理**：自定义菜品分类(荤菜/素菜/汤品/主食等),支持排序
- **订阅通知**：点菜后自动向伴侣推送微信订阅消息
- **厨房命名**：自定义小厨房名称,双方同步显示

## 技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| 前端 | 微信小程序原生 | WXML + WXSS + JS |
| UI | WeUI | 微信官方组件库 |
| 后端 | 微信云函数 | Node.js + wx-server-sdk |
| 数据库 | 微信云数据库 | NoSQL 文档数据库 |
| 存储 | 微信云存储 | 菜品图片 |
| 通知 | 微信订阅消息 | 点菜/新菜品通知 |

无任何第三方 API 依赖,完全运行在微信云开发生态内。

## 项目结构

```
├── cloudfunctions/             # 云函数(后端)
│   ├── createUser/             # 用户注册/登录,生成邀请码
│   ├── bindPartner/            # 伴侣配对绑定
│   ├── unbindPartner/          # 解除绑定
│   ├── getCoupleData/          # 查询伴侣共享数据
│   ├── updateCoupleData/       # 更新/删除共享数据
│   ├── manageCategory/         # 分类管理(增删改查 + 默认初始化)
│   ├── updateKitchenName/      # 更新厨房名称
│   ├── sendNotify/             # 发送订阅消息通知
│   └── getOpenId/              # 获取用户 OpenID
├── miniprogram/                # 小程序前端
│   ├── app.js                  # 全局逻辑(用户管理、绑定守卫、云初始化)
│   ├── app.json                # 页面路由与 TabBar 配置
│   ├── app.wxss                # 全局样式
│   ├── envList.js              # 云环境配置 ← 需要修改
│   ├── components/
│   │   └── bind-guard/         # 绑定状态提醒组件
│   └── pages/
│       ├── index/           # 首页(情侣卡片、今日点菜、快捷入口)
│       ├── order/              # 点菜页(分类选菜、购物车)
│       ├── dishes/             # 菜品库浏览
│       ├── dish-add/            # 添加/编辑菜品
│       ├── dish-detail/         # 菜品详情
│       ├── order-history/       # 历史记录
│       ├── order-detail/        # 订单详情
│       ├── bind/               # 伴侣绑定
│       ├── settings/           # 个人设置
│       └── category-manage/     # 分类管理
└── project.config.json         # 微信开发者工具配置 ← 需要修改
```

### 云函数

| 云函数 | 功能 |
|--------|------|
| createUser | 用户注册/登录 |
| bindPartner | 伴侣绑定 |
| unbindPartner | 解除绑定 |
| getCoupleData | 查询共享数据 |
| updateCoupleData | 更新共享数据 |
| manageCategory | 分类管理 |
| updateKitchenName | 厨房命名 |
| sendNotify | 消息通知 |
| getOpenId | 获取 OpenID |
| getFileURL | 图片临时链接转换 |

## 数据库

| 集合 | 用途 | 数据隔离 |
|------|------|---------|
| User | 用户信息、绑定关系 | openid |
| DishList | 菜品库 | coupleId |
| OrderList | 点菜记录 | coupleId |
| Category | 菜品分类 | coupleId |