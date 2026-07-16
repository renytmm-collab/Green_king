# 原版玩法纠偏报告

## 1. 纠偏原因

旧实现把战场建模为少量固定节点、固定 `edges` 和每方三个固定建筑槽，路线只记录起点与终点节点，更接近节点制策略游戏。当前重构把正式游戏状态改为连续格子领地、己方空格自由建造，以及从兵营绘制到敌方建筑的多段折线路线。

## 2. 保留的功能

保留 Express 与 `ws`、六位房间号、player1/player2 身份、局域网 `0.0.0.0` 监听、服务端权威原则、双方独立金币、建筑价格、矿山定时收入、房间隔离、断线清理、Pointer Events、归一化 Canvas 坐标、启动脚本和 Node 测试框架。

## 3. 删除的旧模型

正式状态不再包含固定 `MAP_NODES`、固定道路 `MAP_EDGES`、`neutral_top/neutral_bottom`、`p1_slot_top` 等固定建筑槽，以及 `fromNodeId/toNodeId` 路线。服务端、客户端和测试均不再依赖节点 ID 或节点相邻关系。

## 4. 新地图模型

每个房间独立创建一份 9 行×18 列地图，共 162 个确定性格子。0–5 列属于 player1，6–11 列为中立战场，12–17 列属于 player2；中立格 `buildable=false`。格子保存 `row`、`column`、`territory`、`terrain`、`buildable`、`blocked` 和 `buildingId`。双方城堡由服务端在第 5 行、第 2/17 列对称创建。当前所有建筑逻辑占地均为 1×1。

## 5. 新建筑模型

房间使用 `Map` 独立保存建筑对象：`id/type/owner/row/column/width/height`；格子只引用 `buildingId`。客户端以 `row/column/buildingType` 请求建造，不能上传身份、价格或 ID。服务端依次验证房间已满、整数与边界、领地、可建造状态、占用、类型和余额，然后生成 ID、扣款、写入建筑与格子并广播完整状态。同步执行使同一格的快速重复请求只能成功一次。

## 6. 新路线模型

客户端从己方兵营中心开始，按归一化距离阈值采样 Pointer Events，松开时一次提交完整 `points`。路线保存 `id/owner/barracksId/targetBuildingId/points`。服务端验证兵营归属、敌方目标、2–100 个有限且位于 0–1 的点、首尾接近对应建筑、最小/最大总长度，并逐线段检查与非首尾建筑格矩形的碰撞。服务端校正首尾为建筑中心。同一兵营最多保留一条路线；合法新路线复用 ID 并覆盖旧点，非法替换不修改旧路线。

## 7. WebSocket 消息

- 建造请求：`{ type: "build", row, column, buildingType }`
- 路线请求：`{ type: "create_route", barracksId, targetBuildingId, points }`
- 成功同步：`game_state`，包含 `players/map/buildings/routes`
- 拒绝：`action_rejected`，包含 `action/reason`，只发给请求者
- 房间生命周期：继续使用 `welcome/opponent_joined/opponent_left/error`

## 8. 美工扩展结构

`public/app.js` 负责 WebSocket、房间状态、菜单和 Pointer Events；`public/renderer.js` 只负责坐标转换、命中测试及地图、领地、网格、建筑、路线、临时路线与选择状态绘制；`public/visual-config.js` 集中视觉参数和预留素材映射。以后可在 `drawCastle/drawMine/drawTower/drawBarracks` 中替换 PNG 或精灵图，而无需修改联网、金币、建造或路线规则。逻辑占地只由行列与宽高决定，不依赖素材像素。

## 9. 修改文件

- 修改：`server.js`、`server/config.js`、`package.json`、`public/app.js`、`public/index.html`、`public/style.css`、`test/server.test.js`、`README.md`
- 新增：`public/renderer.js`、`public/visual-config.js`、`docs/original_gameplay_refactor_report.md`
- 删除：无文件；旧节点/道路模型从正式代码中删除

## 10. 自动测试

命令：`npm test`。最终结果：14 个测试，14 个通过，0 个失败。覆盖地图、房间隔离、城堡、建造权限与重复请求、矿山收入、路线权限/格式/首尾/长度/碰撞/覆盖，以及房间与 WebSocket 回归。测试不依赖真实数秒等待；单测试文件使用 Node 同进程测试隔离以避免 Windows 子进程限制。

## 11. 人工测试

本轮未执行真实设备人工验收：未启动长期服务器，未在电脑浏览器操作，未在手机浏览器操作，也未执行真实 Wi-Fi 局域网联测。需要按 README 使用电脑与手机完成地图显示、触摸拖拽、横竖屏、窗口缩放和断线体验验收。

## 12. 尚未实现功能

士兵生成、士兵移动、战斗、攻击、塔攻击、攻击范围、建筑生命/受伤/摧毁、城堡失败、胜负、升级、多兵种、AI 和动态寻路均未实现。当前美术仍为原创几何占位图形。

## 13. 下一阶段建议

下一阶段应由服务端权威生成士兵，并让士兵沿玩家绘制的多段折线路线逐段移动。不要在起点和终点之间做直线插值，也不要在本阶段提前加入战斗系统。
