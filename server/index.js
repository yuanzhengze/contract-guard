import { config, assertConfig } from './config.js';
import { createApp } from './app.js';

assertConfig();
createApp().listen(config.port, () => {
  console.log(`[合同哨兵] 已启动：http://localhost:${config.port}  模型：${config.llm.model}`);
});
