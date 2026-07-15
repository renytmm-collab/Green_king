# 固定节点地图与兵营路线同步阶段报告

## 目标与地图

实现服务端权威的左右对称固定地图：`p1_castle`、`p1_barracks`、`neutral_top`、`neutral_bottom`、`p2_barracks`、`p2_castle`。所有节点使用 0 到 1 的归一化坐标。

道路连接：城堡—己方兵营；左兵营—两个中立节点；两个中立节点—右兵营；右兵营—城堡。

## 路线流程与验证

客户端通过 Pointer Events 在自己的兵营开始拖拽，并只在本机显示临时线。松开时只发送 `create_route` 与 `fromNodeId`、`toNodeId`。服务端从 WebSocket 连接取得房间和玩家身份，要求房间满两人、节点存在、起点是自己的兵营、目标不同且两者有道路连接。成功后替换该兵营旧路线并向同房间广播 `route_created`；失败仅向发起端发送 `action_rejected`。

加入房间后，服务端发送 `game_map`（`nodes`、`edges`、`routes`）。路线消息为 `{ type: 'route_created', route: { owner, fromNodeId, toNodeId } }`。

## 修改与验证

修改了 `server.js`、`public/app.js`、`public/index.html`、`public/style.css`、`test/server.test.js` 和 `README.md`。新增测试覆盖地图核心节点、越权拒绝与双方路线同步；保留既有指针同步测试。

人工验收：启动服务后用电脑创建房间、手机加入同一 Wi-Fi 下的 LAN 地址；验证双方地图一致、各自只能拖本方兵营、合法路线同步、非法路线提示、调整窗口后节点位置仍一致，以及触摸拖拽。当前环境不能实际执行跨设备手工测试。

## 未完成与下一阶段

本阶段没有士兵生成、移动、战斗、资源或胜负。下一阶段建议在路线同步稳定后，单独设计服务端 tick 与单位状态。
